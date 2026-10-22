'use client';
// Редактор промпта ИИ-анализа (этап 2, только супер-админы). Цикл: правим черновик → «Проверить на
// заказчике» (тест-прогон той же очередью, ~1 мин, в карточку клиента не попадает) → смотрим отчёт и
// разбор → «Сохранить и включить». Каждая версия — «db<id>», отчёты помнят свою; встроенный промпт из
// кода всегда можно вернуть.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/client/apiFetch';
import { MonolitikHelper } from '@/components/mascot/MonolitikHelper';
import { CRITERIA_LABELS, VIOLATION_LABELS } from '../engine/parse';
import { CLIENT_TYPES } from '@/features/client-module/engine/types';
import type { ActivePrompt, PromptVersion } from '../engine/promptStore';
import type { AnalysisRow } from '../engine/store';

interface Payload { active: ActivePrompt; builtin: ActivePrompt; versions: PromptVersion[] }

const fmtDT = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const VERDICT: Record<string, string> = { yes: 'да', partial: 'частично', no: 'нет', na: 'неприменимо' };

async function post(body: unknown) {
  const r = await apiFetch('/api/ai-analysis/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? 'Ошибка');
  return j;
}

export function PromptEditor() {
  const qc = useQueryClient();
  const q = useQuery<Payload>({
    queryKey: ['ai-prompts'],
    queryFn: async () => { const r = await apiFetch('/api/ai-analysis/prompts'); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'Ошибка'); return j; },
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<'company' | 'contact'>('company');
  const [clientId, setClientId] = useState('');
  const [testId, setTestId] = useState<number | null>(null);
  /** Какой текст черновика тестировали — включить можно только проверенный (аудит 23.10). */
  const [testedBody, setTestedBody] = useState<string | null>(null);
  useEffect(() => { if (q.data && draft === null) setDraft(q.data.active.body); }, [q.data, draft]);

  const test = useMutation({
    mutationFn: () => post({ action: 'test', body: draft, [kind === 'company' ? 'companyId' : 'contactId']: clientId.trim() }),
    onSuccess: (j: { id: number }) => { setTestId(j.id); setTestedBody(draft); },
  });
  const save = useMutation({
    mutationFn: (activate: boolean) => post({ action: 'save', body: draft, note, activate }),
    onSuccess: () => { setNote(''); void qc.invalidateQueries({ queryKey: ['ai-prompts'] }); },
  });
  const activate = useMutation({
    mutationFn: (id: number | null) => post({ action: 'activate', id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-prompts'] }),
  });
  const result = useQuery<AnalysisRow>({
    queryKey: ['ai-analysis', testId],
    enabled: testId !== null,
    refetchInterval: s => (s.state.data && (s.state.data.status === 'done' || s.state.data.status === 'error') ? false : 4000),
    queryFn: async () => { const r = await apiFetch(`/api/ai-analysis/${testId}`); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'Ошибка'); return j; },
  });

  if (q.isLoading || draft === null) return <div className="text-sm text-[var(--color-text-muted)]">Загружаем промпт…</div>;
  if (q.error || !q.data) return <div className="text-sm text-[var(--color-negative)]">{q.error instanceof Error ? q.error.message : 'Ошибка'}</div>;
  const { active, builtin, versions } = q.data;
  const dirty = draft !== active.body;
  const r = result.data;
  const running = r && (r.status === 'queued' || r.status === 'running');
  const missing = [1, 2, 3, 4, 5, 6, 7].filter(n => !new RegExp(`^###\\s*${n}\\.`, 'm').test(draft));
  const noMemo = !/^###\s*8\./m.test(draft);
  const testedOk = r?.status === 'done' && testedBody === draft;
  const canActivate = dirty && testedOk && missing.length === 0 && note.trim().length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="text-[13px]">
        Сейчас работает: <b>{active.builtin ? `встроенный из кода (${active.version})` : `версия ${active.version}`}</b>.
        {dirty && <span className="ml-1 text-[var(--color-warning,#b7791f)]">Черновик изменён — не сохранён.</span>}
      </div>
      <textarea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
        className="min-h-[50dvh] w-full max-w-full rounded-lg border border-[var(--color-border)] bg-transparent p-3 font-mono text-base leading-relaxed sm:text-[12.5px]" />
      <div className="text-[11.5px] text-[var(--color-text-muted)]">
        Заголовки «### 1. …» — «### 7. …» обязательны: по ним вкладка разбирает отчёт, сводка — критерии и нарушения;
        «### 8. Памятка менеджеру» — короткая памятка в задачу (без неё в задачу уйдут разделы 3 и 4 целиком).
        Перед промптом модель получает данные заказчика (сделки, факты из CRM, обезличенные звонки) — их здесь нет.
      </div>

      {missing.length > 0 && <div className="text-[13px] font-semibold text-[var(--color-negative)]">Нет заголовков: {missing.map(n => `«### ${n}.»`).join(', ')} — сохранить не получится.</div>}
      {missing.length === 0 && noMemo && <div className="text-[13px] text-[var(--color-warning,#b7791f)]">Нет «### 8. Памятка менеджеру» — в задачу уйдёт длинный текст.</div>}

      {/* Тест-прогон */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] p-3">
        <span className="text-[13px] font-semibold">Проверить на заказчике:</span>
        <div className="flex gap-1" role="tablist">
          {(['company', 'contact'] as const).map(k => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
              className={`min-h-11 rounded-lg border px-3 text-[13px] ${kind === k ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
              {k === 'company' ? 'Компания' : 'Контакт'}
            </button>
          ))}
        </div>
        <input value={clientId} onChange={e => setClientId(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="ID в Битриксе"
          className="min-h-11 w-40 max-w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 text-base sm:text-sm" />
        <button type="button" disabled={!clientId || test.isPending || !!running} onClick={() => test.mutate()}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-[13.5px] font-semibold text-white disabled:opacity-50">
          {running ? 'Идёт тест…' : 'Запустить тест'}
        </button>
        {test.error && <span className="basis-full text-[13px] text-[var(--color-negative)]">{test.error.message}</span>}
      </div>
      {running && <MonolitikHelper pose="work" title="Тест-прогон черновика…" text="Около минуты. В карточку клиента этот отчёт не попадёт." progress="indeterminate" closable={false} />}
      {r?.status === 'error' && <MonolitikHelper pose="alert" title="Тест не получился" text={r.error ?? 'Ошибка'} closable={false} />}
      {r?.status === 'done' && (
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3">
          <div className="text-[13px] font-semibold">Результат теста · {r.seconds} с · {r.costRub ?? '—'} ₽</div>
          <div className="text-[12.5px]">
            Разбор кодом: тип — {CLIENT_TYPES.find(t => t.value === r.parsed?.clientType)?.label ?? 'не распознан'};
            балл — {r.parsed?.score ?? 'не распознан'}; нарушения — {(r.parsed?.violations ?? []).map(v => VIOLATION_LABELS[v]).filter(Boolean).join(', ') || 'нет'}.
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-[var(--color-text-muted)]">
            {CRITERIA_LABELS.map((l, i) => <span key={l}>{i + 1}. {l}: {r.parsed?.criteria[i] ? VERDICT[r.parsed.criteria[i]!] : '?'}</span>)}
          </div>
          <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--color-surface-2,var(--color-bg))] p-3 text-[12.5px] leading-relaxed">{r.reportMd}</pre>
        </div>
      )}

      {/* Сохранение */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Что поменяли — обязательно для включения"
          className="min-h-11 min-w-0 flex-1 basis-56 rounded-lg border border-[var(--color-border)] bg-transparent px-3 text-base sm:text-sm" />
        <button type="button" disabled={!canActivate || save.isPending} onClick={() => save.mutate(true)}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-[13.5px] font-semibold text-white disabled:opacity-50">Сохранить и включить</button>
        <button type="button" disabled={!dirty || missing.length > 0 || save.isPending} onClick={() => save.mutate(false)}
          className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-[13px] disabled:opacity-50">Сохранить черновиком</button>
        <button type="button" onClick={() => setDraft(active.body)} disabled={!dirty}
          className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-[13px] disabled:opacity-50">Сбросить правки</button>
        {dirty && !canActivate && (
          <span className="basis-full text-[12px] text-[var(--color-text-muted)]">
            Включить можно после успешного теста именно этого черновика{testedBody !== null && testedBody !== draft ? ' (после теста текст менялся — запустите тест заново)' : ''} и с описанием, что поменяли.
          </span>
        )}
        {save.error && <span className="basis-full text-[13px] text-[var(--color-negative)]">{save.error.message}</span>}
      </div>

      {/* История */}
      <div className="rounded-xl border border-[var(--color-border)] p-3">
        <div className="mb-1 text-[13px] font-semibold">Версии</div>
        <div className="flex flex-col divide-y divide-[var(--color-border)] text-[12.5px]">
          <div className="flex min-h-11 flex-wrap items-center gap-2 py-1">
            <span className="min-w-0 flex-1">Встроенный из кода · {builtin.version}</span>
            {active.builtin ? <span className="text-[var(--color-positive)]">работает</span> : (
              <button type="button" onClick={() => activate.mutate(null)} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3">Вернуть встроенный</button>
            )}
            <button type="button" onClick={() => setDraft(builtin.body)} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3">В черновик</button>
          </div>
          {versions.map(v => (
            <div key={v.id} className="flex min-h-11 flex-wrap items-center gap-2 py-1">
              <span className="min-w-0 flex-1">{v.version} · {fmtDT(v.createdAt)} · {v.createdBy}{v.note ? ` — ${v.note}` : ''}</span>
              {v.isActive ? <span className="text-[var(--color-positive)]">работает</span> : (
                <button type="button" onClick={() => activate.mutate(v.id)} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3">Включить</button>
              )}
              <button type="button" onClick={() => setDraft(v.body)} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3">В черновик</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
