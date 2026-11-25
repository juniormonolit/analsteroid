'use client';
// Действия РОПа в карточке задачи: назначить менеджера с ТЗ, перенести в колонку (для тача, где нет drag),
// «Принять» (РОП 19.11: работа принята, задача закрывается) / «Принял, работаем дальше» (владелец 18.11: ответ увидел — задача возвращается в работу, НЕ закрывается) /
// вернуть на доработку (задача ждёт контроля; текст необязателен, есть шаблоны вопросов), «Не продано → завершить» (сразу в «проверено»). POST /api/big-deals-kanban/action.
// Закрытие задачи (перенос в AUTO_COMPLETE_COLUMNS, «Не продано → завершить») — только через ConfirmCloseModal.
import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { AUTO_COMPLETE_COLUMNS, BIG_COLUMNS, type BigColumnKey } from '../engine/config';
import type { BigPerson, BigTaskCard } from '../engine/types';
import { TemplatePicker } from './TaskThread';
import { fmtDT } from './format';
import { postBigAction } from './TaskDrawerShared';
import { ConfirmCloseModal } from './MassCloseModal';
import { DeadlineField, mskInputToIso } from './DeadlineField';

type Mode = null | 'reassign' | 'return' | 'accept' | 'approve' | 'renew' | 'deadline';
/** Ждёт подтверждения закрытия: перенос в закрывающую колонку или «Не продано → завершить». */
type PendingClose = null | { type: 'move'; column: BigColumnKey } | { type: 'complete' };

const btn = 'inline-flex min-h-11 items-center justify-center rounded-md border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
const primary = 'inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--color-accent)] px-4 text-[13px] font-medium text-white disabled:opacity-50';
const input = 'w-full min-w-0 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-base sm:text-sm';

export function TaskActions({ card, managers, onChanged, questions, mock = false }: {
  card: BigTaskCard; managers: BigPerson[]; onChanged: (card?: BigTaskCard) => void;
  /** Вопросы из описания — в ТЗ при назначении тем же блоком, что у чата. */
  questions?: string[];
  mock?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [manager, setManager] = useState('');
  const [tz, setTz] = useState('');
  const [comment, setComment] = useState('');
  const [deadline, setDeadline] = useState('');
  const [pending, setPending] = useState<PendingClose>(null);
  const [sure, setSure] = useState(false);
  const closed = card.state === 'done';
  // Просто «Принять» (РОП 19.11): работа принята — задача закрывается. Ждёт контроля или сделка уже выиграна.
  const canApprove = !closed && (card.state === 'control' || card.deal?.closed === 'won');

  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null); setWarn(null);
    try {
      const r = await postBigAction({ taskId: card.id, ...body });
      if (r.warnings?.length) setWarn(r.warnings.join('; '));
      setMode(null); setComment(''); setDeadline(''); setSure(false);
      // Выбранного менеджера и ТЗ сбрасывает только само назначение: срок/перенос между делом их не теряют.
      if (body.type === 'reassign') { setTz(''); setManager(''); }
      setPending(null);
      onChanged(r.card);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPending(null); }
    finally { setBusy(false); }
  };

  // Первым — ответственный по СДЕЛКЕ (РОП 18.11: обычно назначают его), с пометкой.
  const dealOwner = card.deal?.assigned ?? null;
  const managerOptions = [
    ...(dealOwner ? [{ value: dealOwner.id, label: dealOwner.name, hint: 'ответственный по сделке' }] : []),
    ...managers.filter(m => m.id !== dealOwner?.id).map(m => ({ value: m.id, label: m.name })),
  ];
  const toggle = (m: Mode) => { setMode(mode === m ? null : m); setSure(false); setErr(null); if (m === 'reassign' && mode !== 'reassign' && !manager && dealOwner && dealOwner.id !== card.responsible.id) setManager(dealOwner.id); };
  const deadlineIso = mskInputToIso(deadline);
  const columnOptions = BIG_COLUMNS.filter(c => c.key !== card.column).map(c => ({ value: c.key, label: c.title, hint: c.hint ?? null }));
  const addTz = (t: string) => setTz(prev => (prev.trim() ? `${prev.trimEnd()}\n${t}` : t));
  const addComment = (t: string) => setComment(prev => (prev.trim() ? `${prev.trimEnd()}\n${t}` : t));

  const TITLES: Record<Exclude<Mode, null>, string> = {
    reassign: 'Назначить менеджера', return: 'Вернуть на доработку', approve: 'Принять работу', accept: 'Принял, работаем дальше',
    deadline: 'Срок задачи', renew: 'Возобновить задачу',
  };
  const [more, setMore] = useState(false);
  const pick = (m: Mode) => { setMore(false); toggle(m); };
  const control = card.state === 'control';
  const moreItem = 'flex min-h-11 w-full items-center rounded px-2.5 text-left text-[13px] hover:bg-[var(--color-bg-hover)] sm:min-h-9';

  // Спецификация Fable 25.11: одна строка действий по состоянию задачи (первичное — первым), редкое — в «⋯»;
  // формы — в модалке (на телефоне bottom-sheet), а не раскрываются в потоке и не уталкивают чат за экран.
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {closed && <button type="button" className={primary} disabled={busy} onClick={() => toggle('renew')}>Возобновить</button>}
        {canApprove && <button type="button" className={primary} disabled={busy} onClick={() => toggle('approve')} title="Работа принята — задача закроется">Принять</button>}
        {control && <button type="button" className={btn} disabled={busy} onClick={() => toggle('return')}>Вернуть</button>}
        {!closed && !control && <button type="button" className={card.unassigned ? primary : btn} disabled={busy} onClick={() => toggle('reassign')}>Назначить</button>}
        {!closed && <button type="button" className={btn} disabled={busy} onClick={() => toggle('deadline')} title={card.deadlineAt ? `Сейчас: ${fmtDT(card.deadlineAt)}` : 'Срок не задан'}>Срок</button>}
        <SearchSelect options={columnOptions} value="" placeholder="Перенести в…" ariaLabel="Перенести в колонку" disabled={busy}
          className="min-h-11 w-44 max-w-full" onChange={v => {
            if (!v) return;
            const column = v as BigColumnKey;
            if (AUTO_COMPLETE_COLUMNS.has(column) && !closed) setPending({ type: 'move', column });
            else void run({ type: 'move', column });
          }} />
        {!closed && (
          <Popover open={more} onOpenChange={setMore} align="end" className="w-64 max-w-[calc(100vw-16px)] p-1"
            trigger={<button type="button" className={`${btn} px-2.5`} aria-label="Ещё действия" title="Ещё действия"><MoreHorizontal size={16} /></button>}>
            <div className="flex flex-col">
              {control && <button type="button" className={moreItem} onClick={() => pick('accept')}>Принял, работаем дальше</button>}
              {control && <button type="button" className={moreItem} onClick={() => pick('reassign')}>Назначить другого менеджера</button>}
              <button type="button" className={`${moreItem} text-[var(--color-negative)]`} onClick={() => { setMore(false); setPending({ type: 'complete' }); }}>Не продано → завершить</button>
            </div>
          </Popover>
        )}
      </div>
      {!mode && err && <p className="text-[12.5px] text-[var(--color-negative)]">{err}</p>}
      {!mode && warn && <p className="text-[12.5px] text-[var(--color-warning)]">{warn}</p>}

      <Modal open={mode !== null} onOpenChange={o => { if (!o && !busy) { setMode(null); setErr(null); } }} title={mode ? TITLES[mode] : ''} desktopWidth="sm:max-w-xl">
      <div className="flex min-w-0 flex-col gap-3 text-[13px]">
        {mode === 'reassign' && (
          <div className="flex flex-col gap-2">
            <SearchSelect options={managerOptions} value={manager} onChange={setManager} placeholder="Выберите менеджера" searchable ariaLabel="Менеджер" className="min-h-11 w-full" />
            <TemplatePicker questions={questions} deal={card.deal} mock={mock} onInsert={addTz} />
            <textarea value={tz} onChange={e => setTz(e.target.value)} rows={4} placeholder="ТЗ менеджеру — уйдёт в чат задачи" className={input} />
            {/* Срок — здесь же (Осипов 25.11: выбирал менеджера, шёл в «Изменить срок» → «Сегодня», и выбор менеджера пропадал). */}
            <DeadlineField label={`Срок (необязательно${card.deadlineAt ? `, сейчас ${fmtDT(card.deadlineAt)}` : ''})`} value={deadline} onChange={setDeadline} />
            <button type="button" className={`${primary} self-end`} disabled={busy || !manager} onClick={() => run({ type: 'reassign', responsibleId: manager, comment: tz.trim() || undefined, deadline: deadlineIso })}>
              {busy ? 'Назначаю…' : 'Назначить'}
            </button>
          </div>
        )}

        {mode === 'return' && (
          <div className="flex flex-col gap-2">
            <TemplatePicker questions={questions} deal={card.deal} mock={mock} onInsert={addComment} />
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Что доделать (необязательно) — уйдёт в чат жирным" className={input} />
            <DeadlineField label="Новый срок (необязательно)" value={deadline} onChange={setDeadline} />
            <button type="button" className={`${primary} self-end`} disabled={busy}
              onClick={() => run({ type: 'return', comment: comment.trim() || undefined, deadline: deadlineIso })}>
              {busy ? 'Возвращаю…' : 'Вернуть'}
            </button>
          </div>
        )}

        {mode === 'approve' && (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-[var(--color-text-muted)]">Работа принята — задача закроется в Битриксе{card.deal?.closed === 'won' ? ' и встанет в «Продано»' : ''}. Вернуть — кнопкой «Возобновить».</p>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Комментарий менеджеру (необязательно)" className={input} />
            <button type="button" className={`${primary} self-end`} disabled={busy}
              onClick={() => run({ type: 'approve', comment: comment.trim() || undefined })}>
              {busy ? 'Принимаю…' : 'Принять и закрыть'}
            </button>
          </div>
        )}

        {mode === 'accept' && (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-[var(--color-text-muted)]">Задача вернётся менеджеру в работу (не закроется), в чат уйдёт «РОП посмотрел ответ, работаем дальше». Закрыть — «Не продано → завершить» или перенос в «Продано».</p>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Комментарий менеджеру (необязательно)" className={input} />
            <DeadlineField label="Новый срок (необязательно)" value={deadline} onChange={setDeadline} />
            <button type="button" className={`${primary} self-end`} disabled={busy}
              onClick={() => run({ type: 'accept', comment: comment.trim() || undefined, deadline: deadlineIso })}>
              {busy ? 'Отправляю…' : 'Принял, работаем дальше'}
            </button>
          </div>
        )}

        {mode === 'deadline' && (
          <div className="flex flex-col gap-2">
            <DeadlineField label={`Срок исполнения${card.deadlineAt ? ` (сейчас ${fmtDT(card.deadlineAt)})` : ' (сейчас не задан)'}`} value={deadline} onChange={setDeadline} />
            <button type="button" className={`${primary} self-end`} disabled={busy || !deadline} onClick={() => run({ type: 'deadline', deadline: deadlineIso })}>
              {busy ? 'Сохраняю…' : 'Поставить срок'}
            </button>
          </div>
        )}

        {mode === 'renew' && (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-[var(--color-text-muted)]">Задача снова станет открытой у {card.responsible.name}, в чат уйдёт, кто и до какого числа её возобновил.</p>
            <DeadlineField label="Новый срок исполнения (обязательно)" value={deadline} onChange={v => { setDeadline(v); setSure(false); }} />
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Комментарий (необязательно)" className={input} />
            {!sure ? (
              <button type="button" className={`${primary} self-end`} disabled={busy || !deadline} onClick={() => setSure(true)}>Возобновить…</button>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="text-[12.5px]">Возобновить до {deadline ? fmtDT(deadlineIso ?? null) : ''}?</span>
                <button type="button" className={btn} disabled={busy} onClick={() => setSure(false)}>Нет</button>
                <button type="button" className={primary} disabled={busy} onClick={() => run({ type: 'renew', deadline: deadlineIso, comment: comment.trim() || undefined })}>
                  {busy ? 'Возобновляю…' : 'Да, возобновить'}
                </button>
              </div>
            )}
          </div>
        )}

        {err && <p className="text-[var(--color-negative)]">{err}</p>}
      </div>
      </Modal>

      {pending && (
        <ConfirmCloseModal count={1} busy={busy} onCancel={() => setPending(null)}
          title={pending.type === 'complete' ? 'Не продано — закрыть сразу в «проверено»?' : `Перенести в «${BIG_COLUMNS.find(c => c.key === pending.column)?.title}» и закрыть?`}
          onConfirm={() => void run(pending.type === 'complete' ? { type: 'complete' } : { type: 'move', column: pending.column })} />
      )}
    </div>
  );
}
