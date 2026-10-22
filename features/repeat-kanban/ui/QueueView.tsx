'use client';
// Вкладка «Очередь» канбана повторных (миграция 237, владелец 22.10). По менеджерам — в работе / норма,
// в очереди, выдано сегодня, прогноз; ниже позиции: порядок (по срочности), кто поставил, срок,
// «выдать сейчас», поднять/опустить, снять. Внизу — ошибки и недавно выданные/снятые (7 дней).
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, Send, Trash2 } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { taskUrl } from '../engine/config';

interface QItem {
  id: number; clientKey: string; clientName: string | null; managerId: string; managerName: string;
  queuedByName: string | null; deadlineRule: string; deadlineTime: string; boost: number; status: string;
  score: number | null; position: number | null; lastError: string | null; comment: string | null;
  issuedTaskId: number | null; issuedDealId: number | null; issuedAt: string | null; removedLabel: string | null; removedAt: string | null; createdAt: string;
}
interface QManager { id: string; name: string; active: boolean; load: number; queued: number; issuedToday: number; failed: number; forecastDays: number }
interface QData { settings: { managerTaskLimit: number; queueDailyLimit: number; workHoursNow: boolean }; managers: QManager[]; items: QItem[] }

const RULE: Record<string, string> = { window: 'до конца окна', today: 'в день выдачи', '3': '+3 дня', '7': '+7 дней' };
const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—');
const name = (i: QItem) => i.clientName ?? i.clientKey;
const BTN = 'tap-target inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40';

async function act(body: Record<string, unknown>) {
  const r = await fetch('/api/repeat-kanban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j;
}

export function QueueView({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<QData, Error>({
    queryKey: ['repeat-kanban-queue'],
    queryFn: async () => { const r = await fetch('/api/repeat-kanban/queue'); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'Ошибка'); return j; },
    refetchInterval: 60_000,
  });
  const [mgr, setMgr] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const reload = () => { qc.invalidateQueries({ queryKey: ['repeat-kanban-queue'] }); onChanged(); };
  const run = async (id: number, body: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(id);
    try {
      const j = await act({ ...body, id });
      if (body.action === 'queue_issue_now' && j && j.ok === false) alert(j.error ?? 'Не удалось выдать');
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    setBusy(null); reload();
  };

  const items = useMemo(() => (data?.items ?? []).filter(i => !mgr || i.managerId === mgr), [data, mgr]);
  const live = items.filter(i => i.status === 'queued' || i.status === 'issuing')
    .sort((a, b) => a.managerName.localeCompare(b.managerName, 'ru') || (a.position ?? 1e9) - (b.position ?? 1e9));
  const failed = items.filter(i => i.status === 'failed');
  const done = items.filter(i => i.status === 'issued' || i.status === 'removed')
    .sort((a, b) => (b.issuedAt ?? b.removedAt ?? '').localeCompare(a.issuedAt ?? a.removedAt ?? ''));

  if (isLoading) return <div className="px-4 py-3 text-sm text-[var(--color-text-muted)] sm:px-6">Загружаю очередь…</div>;
  if (error) return <div className="px-4 py-3 text-sm text-[var(--color-negative)] sm:px-6">{error.message}</div>;
  const s = data!.settings;

  return (
    <div className="flex min-w-0 flex-none flex-col gap-4 px-4 pb-6 pt-3 sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:overflow-x-hidden sm:px-6">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Задачи из очереди выдаются по срочности, пока у менеджера активных меньше {s.managerTaskLimit}, — не больше {s.queueDailyLimit} в день каждому,
        по будням с 9 до 18 МСК{s.workHoursNow ? '' : ' (сейчас нерабочее время — выдача на паузе)'}. Сообщение собирается в момент выдачи.
      </p>
      {data!.managers.length === 0 ? (
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">
          Очередь пуста. Поставить: «Выбрать» → отметить карточки → «Поставить задачи» → «В очередь», или в окне задачи — «В очередь».
        </div>
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {data!.managers.map(m => (
              <button key={m.id} type="button" onClick={() => setMgr(mgr === m.id ? '' : m.id)}
                className={`flex min-w-0 flex-col gap-1 rounded-xl border p-3 text-left text-sm ${mgr === m.id ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'}`}>
                <span className="truncate font-semibold text-[var(--color-text)]">{m.name}</span>
                {!m.active && <span className="text-xs font-semibold text-[var(--color-negative)]">Неактивен — очередь заморожена, переназначьте</span>}
                <span className="text-xs text-[var(--color-text-secondary)]">
                  в работе {m.load}/{s.managerTaskLimit} · в очереди {m.queued} · сегодня выдано {m.issuedToday}/{s.queueDailyLimit}
                </span>
                <span className="text-xs text-[var(--color-text-muted)]">{m.queued ? `очередь примерно на ${m.forecastDays} раб. ${m.forecastDays === 1 ? 'день' : m.forecastDays < 5 ? 'дня' : 'дней'}` : 'очередь пуста'}{m.failed ? ` · ошибок ${m.failed}` : ''}</span>
              </button>
            ))}
          </div>
          <div className="max-w-xs">
            <SearchSelect ariaLabel="Менеджер" value={mgr} onChange={setMgr}
              options={[{ value: '', label: 'Все менеджеры' }, ...data!.managers.map(m => ({ value: m.id, label: m.name, hint: `в очереди ${m.queued}` }))]}
              className="w-full justify-start" />
          </div>
          <Section title={`В очереди · ${live.length}`}>
            {live.map(i => (
              <Row key={i.id} i={i}
                actions={<>
                  <button type="button" className={BTN} title="Поднять" aria-label="Поднять" disabled={busy === i.id || i.boost >= 2} onClick={() => run(i.id, { action: 'queue_boost', boost: i.boost + 1 })}><ArrowUp size={15} /></button>
                  <button type="button" className={BTN} title="Опустить" aria-label="Опустить" disabled={busy === i.id || i.boost <= -2} onClick={() => run(i.id, { action: 'queue_boost', boost: i.boost - 1 })}><ArrowDown size={15} /></button>
                  <button type="button" className={BTN} title="Выдать сейчас (без нормы и лимита)" aria-label="Выдать сейчас" disabled={busy === i.id || i.status !== 'queued'}
                    onClick={() => run(i.id, { action: 'queue_issue_now' }, `Выдать задачу по «${name(i)}» прямо сейчас — ${i.managerName}?`)}><Send size={15} /></button>
                  <button type="button" className={BTN} title="Снять из очереди" aria-label="Снять из очереди" disabled={busy === i.id || i.status !== 'queued'}
                    onClick={() => run(i.id, { action: 'queue_remove' }, `Снять «${name(i)}» из очереди?`)}><Trash2 size={15} /></button>
                </>} />
            ))}
          </Section>
          {failed.length > 0 && (
            <Section title={`Ошибки выдачи · ${failed.length}`}>
              {failed.map(i => <Row key={i.id} i={i} note={i.lastError} />)}
            </Section>
          )}
          {done.length > 0 && (
            <Section title={`Выдано и снято за 7 дней · ${done.length}`}>
              {done.slice(0, 200).map(i => <Row key={i.id} i={i} note={i.status === 'removed' ? `снята: ${i.removedLabel ?? '—'}${i.lastError ? ` — ${i.lastError}` : ''}` : null} />)}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
      <div className="flex min-w-0 flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">{children}</div>
    </section>
  );
}

function Row({ i, actions, note }: { i: QItem; actions?: React.ReactNode; note?: string | null }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      {i.position !== null && <span className="w-8 shrink-0 text-right tabular-nums text-[var(--color-text-muted)]">#{i.position}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[var(--color-text)]">{name(i)}{i.boost ? <span className="ml-1 text-xs text-[var(--color-accent)]">{i.boost > 0 ? `▲${i.boost}` : `▼${-i.boost}`}</span> : null}</div>
        <div className="truncate text-xs text-[var(--color-text-muted)]">
          {i.managerName} · поставил {i.queuedByName ?? '—'} {fmtDT(i.createdAt)} · срок {RULE[i.deadlineRule] ?? i.deadlineRule}, {i.deadlineTime}
          {i.score !== null ? ` · срочность ${i.score.toFixed(1)}` : ''}
        </div>
        {i.status === 'issued' && i.issuedTaskId && (
          <a href={taskUrl(i.issuedTaskId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline">
            <ExternalLink size={11} /> выдана {fmtDT(i.issuedAt)} · задача #{i.issuedTaskId}
          </a>
        )}
        {note && <div className="text-xs text-[var(--color-negative)]">{note}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}
