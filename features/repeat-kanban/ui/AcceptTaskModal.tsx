'use client';
// Приёмка задачи из канбана (владелец 22.10): «принимать задачи и сразу браковать сделки. 3 кнопки:
// принять задачу и закрыть сделку (и выбор стадии), принять задачу, отправить на доработку».
// Задача в «ждёт контроля» (менеджер сдал); решение и комментарий уходят в задачу от имени РОПа.
import { useState } from 'react';
import { CheckCircle2, ExternalLink, RotateCcw, XCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { BRAK_REASONS, taskUrl } from '../engine/config';
import type { KanbanCard } from '../engine/board';
import type { TaskNote } from '../engine/taskNotes';

type Mode = 'close' | 'accept' | 'return';
const MODES: { key: Mode; title: string; hint: string; Icon: typeof CheckCircle2; color: string }[] = [
  { key: 'close', title: 'Принять и закрыть сделку', hint: 'Задача завершится, сделка закроется в отказ, заказчик — в «Брак»', Icon: XCircle, color: '#990000' },
  { key: 'accept', title: 'Принять задачу', hint: 'Задача завершится, сделка остаётся как есть', Icon: CheckCircle2, color: '#38761d' },
  { key: 'return', title: 'На доработку', hint: 'Задача вернётся менеджеру в работу с вашим комментарием', Icon: RotateCcw, color: '#b45f06' },
];

const field = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-text)] sm:text-sm';
const mskYmd = (plusDays: number) => new Date(Date.now() + 3 * 3600_000 + plusDays * 86_400_000).toISOString().slice(0, 10);

export function AcceptTaskModal({ card, name, note, onClose, onSaved }: {
  card: KanbanCard; name: string; note: TaskNote | null; onClose: () => void; onSaved: () => void;
}) {
  const task = card.task!;
  const [mode, setMode] = useState<Mode>('accept');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  // Новый срок при возврате: старый уже прошёл — по умолчанию завтра 19:00.
  const overdue = !!task.deadlineAt && new Date(task.deadlineAt).getTime() < Date.now() + 3600_000;
  const [deadline, setDeadline] = useState(overdue ? mskYmd(1) : '');
  const [time, setTime] = useState('19:00');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = mode === 'close' ? !!reason : mode === 'return' ? comment.trim().length >= 3 : true;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = mode === 'return'
        ? { action: 'task_return', comment, deadline: deadline || null, deadlineTime: time }
        : { action: 'task_accept', comment, closeReason: mode === 'close' ? reason : null };
      const r = await fetch('/api/repeat-kanban', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, taskId: task.id, dealId: task.dealId, clientKey: card.clientKey, managerId: card.managerId, column: card.column }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      if (mode === 'close' && j.dealClosed && j.dealClosed !== 'closed' && j.dealClosed !== 'already_closed') {
        alert(`Задача принята, заказчик в «Браке», но сделку #${task.dealId} закрыть не удалось (${j.dealClosed}) — закройте её в Битриксе.`);
      }
      onSaved(); onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Приёмка задачи · ${name}`} desktopWidth="sm:max-w-lg">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <a href={taskUrl(task.id)} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-[var(--color-accent)] hover:underline">
          <ExternalLink size={13} className="shrink-0" /><span className="truncate">Задача #{task.id} · {task.responsibleName ?? 'менеджер'} · сделка #{task.dealId}</span>
        </a>
        {note && (
          <div className="rounded-md border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-[13px]">
            <div className="text-xs text-[var(--color-text-muted)]">{note.isResult ? 'Результат' : 'Комментарий'} · {note.author}</div>
            <div className="max-h-40 overflow-y-auto whitespace-pre-line text-[var(--color-text)]">{note.text}</div>
          </div>
        )}
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Решение по задаче">
          {MODES.map(m => (
            <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} onClick={() => setMode(m.key)}
              className={`flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-left ${mode === m.key ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
              <m.Icon size={18} className="mt-0.5 shrink-0" style={{ color: m.color }} />
              <span className="min-w-0">
                <span className="block font-semibold text-[var(--color-text)]">{m.title}</span>
                <span className="block text-xs text-[var(--color-text-muted)]">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>
        {mode === 'close' && (
          <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
            Стадия закрытия сделки
            <SearchSelect ariaLabel="Стадия закрытия сделки" value={reason} onChange={setReason} placeholder="Выберите стадию отказа"
              options={BRAK_REASONS.map(r => ({ value: r.value, label: r.label }))} className="w-full justify-start" />
          </label>
        )}
        {mode === 'return' && (
          <div className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
            Новый срок {overdue ? '(старый уже прошёл)' : '(необязательно)'}
            <div className="flex flex-wrap gap-2">
              <input type="date" value={deadline} min={mskYmd(0)} onChange={e => setDeadline(e.target.value)} aria-label="Новая дата срока" className={`${field} min-h-11 min-w-0 flex-1`} />
              <input type="time" value={time} onChange={e => setTime(e.target.value)} disabled={!deadline} aria-label="Время срока" className={`${field} min-h-11 w-32`} />
            </div>
          </div>
        )}
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          {mode === 'return' ? 'Что доделать (обязательно)' : 'Комментарий в задачу (необязательно)'}
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} className={field}
            placeholder={mode === 'return' ? 'Переведи сделку в стадию и поставь дату следующего звонка' : mode === 'close' ? 'Почему закрываем' : 'Молодец, всё по делу'} />
        </label>
        <p className="text-xs text-[var(--color-text-muted)]">Решение и комментарий уйдут в задачу от вашего имени.</p>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || !ready} onClick={submit}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">
            {busy ? 'Сохраняю…' : MODES.find(m => m.key === mode)!.title}
          </button>
        </div>
      </div>
    </Modal>
  );
}
