'use client';
// Анкета заказчика в карточке клиента (миграция 249, владелец 23.10): вопросы анкет его товарных групп и общие.
// У каждого вопроса — ответ менеджера (заполняет здесь, в т.ч. во вкладке Битрикса) и, если есть, ответ «по
// разговорам» (из разбора звонков, с цитатой) — оба хранятся и показываются; «Подтвердить» переносит ответ по
// разговорам в ответ менеджера. Менеджеры не должны знать, что это ИИ (владелец 23.10) — подпись «по разговорам».
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, ChevronRight, MessageSquareQuote, Pencil } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import { COMMON_GROUP } from '../engine/types';
import type { ClientQuestion, StoredAnswer } from '../engine/answers';
import { QuestionInput } from './QuestionnaireForm';
import { TabError, TabLoading } from '@/features/client-module/ui/parts';

type Val = string | string[];
const toVal = (a: StoredAnswer | null, kind: ClientQuestion['kind']): Val =>
  !a ? (kind === 'multi' ? [] : '') : kind === 'text' ? a.text ?? '' : kind === 'multi' ? a.options ?? [] : a.options?.[0] ?? '';
const isEmpty = (v: Val | undefined) => (Array.isArray(v) ? v.length === 0 : !v?.trim());
const same = (a: Val | undefined, b: Val | undefined) => JSON.stringify(Array.isArray(a) ? [...a].sort() : (a ?? '').trim()) === JSON.stringify(Array.isArray(b) ? [...b].sort() : (b ?? '').trim());
const fmtD = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Europe/Moscow' });
const showVal = (a: StoredAnswer) => [...(a.options ?? []), ...(a.text ? [a.text] : [])].join(', ');

export function ClientQuestionnaire({ params, shippedGroups, offeredGroups }: {
  /** contactId | companyId — как у остальных запросов карточки. */
  params: Record<string, string>;
  /** Отгруженные группы (свежие первыми) — их анкеты; общие — всегда. */
  shippedGroups: string[];
  /** Что предложим — анкеты этих групп отдельным свёрнутым блоком. */
  offeredGroups: string[];
}) {
  const qc = useQueryClient();
  const groups = useMemo(() => [...new Set([...shippedGroups, ...offeredGroups])], [shippedGroups, offeredGroups]);
  const qs = new URLSearchParams({ ...params, groups: groups.join('|') }).toString();
  const { data, error, isLoading, refetch } = useQuery<ClientQuestion[], Error>({
    queryKey: ['client-questionnaire', qs],
    queryFn: async () => {
      const r = await apiFetch(`/api/modules/client-card/questionnaire?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j.questions as ClientQuestion[];
    },
  });
  const [draft, setDraft] = useState<Record<number, Val>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showOffered, setShowOffered] = useState(false);
  // Компактно (аудит 23.10: 18 вопросов по textarea — экран на четыре прокрутки): секции сворачиваются, отвеченный
  // вопрос — текстом с «изменить». collapsed — свёрнутые вручную; по умолчанию свёрнуты полностью отвеченные.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Set<number>>(new Set());

  if (isLoading) return <TabLoading text="Загрузка анкеты…" />;
  if (error) return <TabError error={error} onRetry={() => void refetch()} />;
  const all = data ?? [];
  if (!all.length) {
    return <p className="p-3 text-sm text-[var(--color-text-muted)]">Анкет по товарным группам этого заказчика пока нет — их заводят в «Ещё → Что предложить → Анкеты по группам».</p>;
  }
  const valOf = (q: ClientQuestion) => (q.id! in draft ? draft[q.id!] : toVal(q.manager, q.kind));
  const dirty = all.filter(q => q.id! in draft && !same(draft[q.id!], toVal(q.manager, q.kind)));
  const answered = all.filter(q => !isEmpty(valOf(q)) || q.ai).length;
  const shippedSet = new Set([COMMON_GROUP, ...shippedGroups]);
  const offeredOnly = offeredGroups.filter(g => !shippedSet.has(g));
  const sections = [
    ...[COMMON_GROUP, ...shippedGroups].map(g => ({ group: g, offered: false })),
    ...offeredOnly.map(g => ({ group: g, offered: true })),
  ].map(s => ({ ...s, qs: all.filter(q => q.group === s.group) })).filter(s => s.qs.length);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const answers = dirty.map(q => {
        const v = draft[q.id!];
        return Array.isArray(v) ? { questionId: q.id, options: v } : q.kind === 'text' ? { questionId: q.id, text: v } : { questionId: q.id, options: v ? [v] : [] };
      });
      const r = await apiFetch('/api/modules/client-card/questionnaire', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, answers }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      setDraft({});
      setEditing(new Set());
      await qc.invalidateQueries({ queryKey: ['client-questionnaire', qs] });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px]">
          <span className="font-semibold text-[var(--color-text)]">Отвечено {answered} из {all.length}</span>
          <span className="text-xs text-[var(--color-text-muted)]">ответы «по разговорам» заполняются сами — проверьте и подтвердите или ответьте сами</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg-hover)]" role="progressbar" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={answered} aria-label="Анкета заполнена">
          <div className="h-full rounded-full bg-[var(--color-positive,#2f9e44)] transition-[width]" style={{ width: `${all.length ? (answered / all.length) * 100 : 0}%` }} />
        </div>
      </div>
      {sections.map(s => {
        if (s.offered && !showOffered) return null;
        const done = s.qs.filter(q => !isEmpty(valOf(q)) || q.ai).length;
        const open = toggled[s.group] ?? done < s.qs.length;
        return (
        <section key={s.group} className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--color-border)] p-3">
          <button type="button" aria-expanded={open} onClick={() => setToggled(t => ({ ...t, [s.group]: !open }))}
            className="-m-1 flex min-h-11 items-center gap-2 rounded-lg p-1 text-left hover:bg-[var(--color-bg-hover)]">
            {open ? <ChevronDown size={16} className="shrink-0 text-[var(--color-text-muted)]" /> : <ChevronRight size={16} className="shrink-0 text-[var(--color-text-muted)]" />}
            <span className="min-w-0 flex-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              {s.group === COMMON_GROUP ? 'Общие вопросы' : s.group}
              {s.offered && <span className="ml-1.5 font-normal normal-case tracking-normal">· что предложим</span>}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${done === s.qs.length ? 'bg-[color-mix(in_srgb,var(--color-positive,#2f9e44)_14%,transparent)] text-[var(--color-positive,#2f9e44)]' : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'}`}>{done}/{s.qs.length}</span>
          </button>
          {open && s.qs.map(q => {
            const v = valOf(q);
            const aiVal = q.ai ? toVal(q.ai, q.kind) : null;
            const conflict = q.ai && q.manager && !same(aiVal!, toVal(q.manager, q.kind));
            return (
              <fieldset key={q.id} className={`flex min-w-0 flex-col gap-1.5 ${conflict ? 'rounded-lg border-l-2 border-[var(--color-warning,#e8590c)] pl-2' : ''}`}>
                <legend className="mb-1 text-sm font-medium text-[var(--color-text)]">
                  {q.question}{q.required && <span className="text-[var(--color-negative)]"> *</span>}
                </legend>
                {q.hint && <p className="-mt-1 text-xs text-[var(--color-text-muted)]">{q.hint}</p>}
                {/* Отвеченный — текстом, поле — по «изменить» (или пока есть несохранённая правка). */}
                {q.manager && !(q.id! in draft) && !editing.has(q.id!) ? (
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="min-w-0 whitespace-pre-line text-[13.5px] text-[var(--color-text)]">{showVal(q.manager) || '—'}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">{q.manager.by ?? '—'} · {fmtD(q.manager.at)}</span>
                    <button type="button" onClick={() => setEditing(e => new Set(e).add(q.id!))}
                      className="tap-target inline-flex min-h-9 items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline"><Pencil size={12} /> изменить</button>
                  </div>
                ) : (
                  <QuestionInput q={q} name={`cq-${q.id}`} value={v} onChange={nv => setDraft(d => ({ ...d, [q.id!]: nv }))} />
                )}
                {q.ai && (
                  <div className="flex min-w-0 flex-col gap-1 rounded-md bg-[var(--color-bg-surface)] px-2 py-1.5 text-[12.5px]">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                        <MessageSquareQuote size={12} /> по разговорам{q.ai.calledAt ? ` · звонок ${fmtD(q.ai.calledAt)}` : ''}
                      </span>
                      {conflict && <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-[var(--color-warning,#e8590c)]"><AlertTriangle size={11} /> расходится с ответом менеджера</span>}
                    </div>
                    <div className="text-[var(--color-text)]">{showVal(q.ai) || '—'}</div>
                    {q.ai.quote && <div className="italic text-[var(--color-text-secondary)]">«{q.ai.quote}»</div>}
                    {!same(aiVal!, v) && (
                      <button type="button" onClick={() => setDraft(d => ({ ...d, [q.id!]: aiVal! }))}
                        className="inline-flex min-h-11 items-center gap-1 self-start rounded-md border border-[var(--color-border)] px-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                        <Check size={12} /> Подтвердить
                      </button>
                    )}
                  </div>
                )}
              </fieldset>
            );
          })}
        </section>
        );
      })}
      {offeredOnly.some(g => all.some(q => q.group === g)) && (
        <button type="button" onClick={() => setShowOffered(v => !v)}
          className="min-h-11 self-start rounded-lg px-2 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          {showOffered ? 'Скрыть анкеты того, что предложим' : 'Показать анкеты того, что предложим'}
        </button>
      )}
      {(dirty.length > 0 || err) && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-2">
          {err && <span className="mr-auto text-sm text-[var(--color-negative)]">{err}</span>}
          <button type="button" onClick={() => { setDraft({}); setErr(null); }} className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отменить</button>
          <button type="button" disabled={busy || !dirty.length} onClick={save} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm text-white disabled:opacity-50">
            {busy ? 'Сохраняю…' : `Сохранить ответы · ${dirty.length}`}
          </button>
        </div>
      )}
    </div>
  );
}
