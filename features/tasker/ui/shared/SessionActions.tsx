'use client';
// Действия у сессии в «Неделе»/«Сегодня» (UX-аудит 23.11, п.39): «Провёл» (отметка, задачи не закрывает) и
// «Перенести» (новое время → событие календаря и плановые даты задач в Битриксе). PATCH /api/tasker/sessions/:id.
// Видно только тем, кому сервер разрешил (session.canManage: исполнитель, его директор, админ).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, Undo2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { TaskerSession, TaskerSessionPatchRequest, TaskerSessionPatchResponse } from '../../types';
import { TASKS_KEY } from './api';
import { AvailabilityWarning } from './AvailabilityWarning';
import { fmtDT } from './format';

async function patchSession(id: number, body: TaskerSessionPatchRequest): Promise<TaskerSessionPatchResponse> {
  const r = await fetch(`/api/tasker/sessions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `Ошибка ${r.status}`);
  return j as TaskerSessionPatchResponse;
}

/** Время в поле — по Москве, как во всём Задачнике (у браузера в другом поясе иначе «16:00» превратилось бы в «15:00»). */
const toMskInput = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 16);
const fromMskInput = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? new Date(`${v}:00+03:00`).toISOString() : null);
const DURATIONS = [30, 45, 60, 90];
const BTN = 'inline-flex min-h-9 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[11.5px] font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';

export function SessionActions({ session: s }: { session: TaskerSession }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState(() => toMskInput(s.slotStart));
  const [dur, setDur] = useState(s.durationMin);
  const [note, setNote] = useState<string | null>(null);
  if (!s.canManage) return null;

  const started = new Date(s.slotStart).getTime() <= Date.now() + 15 * 60_000;
  const run = async (body: TaskerSessionPatchRequest) => {
    setBusy(true); setError(null);
    try {
      const res = await patchSession(s.id, body);
      await qc.invalidateQueries({ queryKey: [TASKS_KEY] });
      return res;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const slotIso = fromMskInput(slot);
  const people = [s.rop.id, ...s.managers.map(m => m.id)];

  return (
    <div className="mt-1.5 flex min-w-0 flex-col gap-1">
      {s.heldAt ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-[var(--color-positive)]/15 px-2 py-1 text-[11.5px] font-medium text-[var(--color-positive)]">
            <Check size={12} aria-hidden /> <span className="truncate">Проведена{s.heldBy ? ` · ${s.heldBy}` : ''}</span>
          </span>
          <button type="button" className={BTN} disabled={busy} onClick={() => run({ action: 'undone' })} title="Снять отметку «Провёл»">
            <Undo2 size={12} aria-hidden /> Отменить
          </button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-1">
          {started && (
            <button type="button" className={BTN} disabled={busy} onClick={() => run({ action: 'done' })}
              title="Отметить, что сессия прошла. Задачи менеджеров завершаются отдельно — с «Что сделано»">
              <Check size={12} aria-hidden /> Провёл
            </button>
          )}
          <button type="button" className={BTN} disabled={busy} onClick={() => { setSlot(toMskInput(s.slotStart)); setDur(s.durationMin); setNote(null); setError(null); setOpen(true); }}>
            <CalendarClock size={12} aria-hidden /> Перенести
          </button>
        </div>
      )}
      {error && !open && <div className="break-words text-[11px] text-[var(--color-negative)]">{error}</div>}

      <Modal open={open} onOpenChange={o => { if (!busy) setOpen(o); }} title={`Перенести сессию · ${s.metricLabel}`} desktopWidth="sm:max-w-md">
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <p className="text-xs text-[var(--color-text-muted)]">
            Сейчас: {fmtDT(s.slotStart)}, {s.durationMin} мин. Событие в календаре Битрикса и плановые даты задач сессии
            ({s.managers.length}) переедут на новое время.
          </p>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-semibold text-[var(--color-text-muted)]">Новое время (МСК)</span>
            <input type="datetime-local" value={slot} onChange={e => setSlot(e.target.value)}
              className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:text-sm" />
          </label>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-semibold text-[var(--color-text-muted)]">Длительность</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Длительность">
              {[...new Set([s.durationMin, ...DURATIONS])].sort((a, b) => a - b).map(d => (
                <button key={d} type="button" role="radio" aria-checked={dur === d} onClick={() => setDur(d)}
                  className={`min-h-11 min-w-14 rounded-lg border px-3 text-sm font-medium ${dur === d
                    ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {d} мин
                </button>
              ))}
            </div>
          </div>
          <AvailabilityWarning req={slotIso && !note ? {
            bitrixIds: people, slots: [{ start: slotIso, end: new Date(Date.parse(slotIso) + dur * 60_000).toISOString() }], exclude: { sessionId: s.id },
          } : null} />
          {note && <div className="rounded-lg bg-[var(--color-positive)]/10 px-3 py-2 text-xs text-[var(--color-text)]">{note}</div>}
          {error && <div className="break-words rounded-lg bg-[var(--color-negative-soft)] px-3 py-2 text-xs text-[var(--color-negative)]">{error}</div>}
          <div className="flex min-w-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" disabled={busy} onClick={() => setOpen(false)}
              className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 text-sm font-medium hover:bg-[var(--color-bg-hover)]">
              {note ? 'Закрыть' : 'Отмена'}
            </button>
            {!note && (
              <button type="button" disabled={busy || !slotIso} onClick={async () => {
                const res = await run({ action: 'reschedule', slotStart: slotIso!, durationMin: dur });
                if (!res) return;
                const busyN = res.availability?.busy.length ?? 0;
                if (!res.warning && busyN === 0) { setOpen(false); return; }
                // Перенос сохранён; показываем, что не так, и оставляем окно открытым.
                setNote([`Перенесено на ${fmtDT(res.session.slotStart)}.`, res.warning,
                  busyN ? `В это время заняты ${busyN}: ${res.availability!.busy.map(p => p.name).join(', ')}.` : null].filter(Boolean).join(' '));
              }}
                className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Переношу…' : 'Перенести'}
              </button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
