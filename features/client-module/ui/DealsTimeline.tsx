'use client';
// Хронология «сделки и задачи» во вкладке «Сделки» (владелец 23.10: «вкладки задач, с ним связанных, нет — объединить
// с „Сделками“, чтобы было видно хронологию сделок и задач: какие были сделки, их результат, какие задачи ставились и
// когда и какой у них результат»). Сделки — свежие сверху; под каждой — её задачи (из копии Битрикса и наших записей,
// history.ts fetchClientTasks) с постановщиком, исполнителем, сроком, статусом и последним «Результатом».
import { useState } from 'react';
import { ClipboardList, ExternalLink } from 'lucide-react';
import { fmtMoney } from '@/features/customers/ui/shared';
import { type ClientModuleData, type ModuleDeal, dealSortDate } from '../engine/types';
import type { HistoryTask } from '../engine/history';
import { Chip, StageChip, dealTitle, fmtD, shortGroup, type Tone } from './parts';
import { DealLink } from './dealLink';

const TASK_STATE: Record<HistoryTask['state'], { label: string; tone: Tone }> = {
  new: { label: 'не начата', tone: 'muted' }, in_progress: { label: 'в работе', tone: 'accent' }, control: { label: 'ждёт приёмки', tone: 'warn' },
  done: { label: 'завершена', tone: 'ok' }, deferred: { label: 'отложена', tone: 'muted' }, declined: { label: 'отклонена', tone: 'neg' },
};
const taskUrl = (id: number) => `https://td.monolit-crm.ru/company/personal/user/0/tasks/task/view/${id}/`;
const overdue = (t: HistoryTask) => t.deadlineAt && t.state !== 'done' && t.state !== 'deferred' && new Date(t.deadlineAt).getTime() < Date.now();
const shortName = (n: string | null) => { if (!n) return '—'; const p = n.trim().split(/\s+/); return p.length >= 2 ? `${p[0]} ${p[1][0]}.` : n; };

function TaskRow({ t }: { t: HistoryTask }) {
  const [full, setFull] = useState(false);
  const st = TASK_STATE[t.state];
  const late = overdue(t);
  return (
    <div className="flex min-w-0 gap-2 py-1.5 pl-1 text-[12.5px]">
      <ClipboardList size={14} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtD(t.createdAt)}</span>
          <a href={taskUrl(t.taskId)} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 font-medium text-[var(--color-accent)] hover:underline">
            <span className="truncate">{t.title}</span><ExternalLink size={11} className="shrink-0 opacity-70" />
          </a>
          <Chip tone={late ? 'neg' : st.tone}>{late ? 'просрочена' : st.label}</Chip>
          {t.repeat && <Chip tone="muted">повторные</Chip>}
        </div>
        <div className="text-[12px] text-[var(--color-text-muted)]">
          {shortName(t.createdByName)} → {shortName(t.responsibleName)}
          {t.deadlineAt && <> · срок {fmtD(t.deadlineAt)}</>}
          {t.closedAt && t.state === 'done' && <> · закрыта {fmtD(t.closedAt)}</>}
        </div>
        {t.result && (
          <button type="button" onClick={() => setFull(v => !v)} title={full ? 'Свернуть' : 'Показать целиком'}
            className="mt-0.5 block w-full rounded-md border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-surface)] px-2 py-1 text-left text-[12.5px] text-[var(--color-text)]">
            <span className="text-[11px] text-[var(--color-text-muted)]">Результат{t.result.at ? ` · ${fmtD(t.result.at)}` : ''}: </span>
            <span className={full ? 'whitespace-pre-line' : 'line-clamp-2'}>{t.result.text}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function DealBlock({ d, tasks }: { d: ModuleDeal; tasks: HistoryTask[] }) {
  const reason = d.stage === 'lost' && d.stageName ? d.stageName : null;
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
        <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtD(d.createdAt)}</span>
        <DealLink dealId={d.dealId} className="min-w-0 truncate font-semibold hover:underline">{dealTitle(d)}</DealLink>
        <StageChip s={d.stage} />
        <span className="ml-auto shrink-0 font-semibold tabular-nums">{d.amount > 0 ? fmtMoney(d.amount) : '—'}</span>
      </div>
      <div className="text-[12px] text-[var(--color-text-muted)]">
        {d.groups.length ? d.groups.slice(0, 3).map(shortGroup).join(', ') + (d.groups.length > 3 ? ` +${d.groups.length - 3}` : '') : 'без товаров'}
        {d.deliveredAt && <> · отгружена {fmtD(d.deliveredAt)}</>}
        {reason && <> · <span className="text-[var(--color-negative,#e03131)]">отказ: {reason}</span>{d.lostAt ? ` ${fmtD(d.lostAt)}` : ''}</>}
        {d.managerName && <> · {d.managerName}</>}
      </div>
      {tasks.length > 0 && (
        <div className="mt-1 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {tasks.map(t => <TaskRow key={t.taskId} t={t} />)}
        </div>
      )}
    </div>
  );
}

export function DealsTimeline({ data, deals, tasks, loading }: { data: ClientModuleData; deals: ModuleDeal[]; tasks: HistoryTask[]; loading: boolean }) {
  const byDeal = new Map<number, HistoryTask[]>();
  for (const t of tasks) if (t.dealId !== null) byDeal.set(t.dealId, [...(byDeal.get(t.dealId) ?? []), t]);
  const known = new Set(data.deals.map(d => d.dealId));
  const loose = tasks.filter(t => t.dealId === null || !known.has(t.dealId));
  const list = [...deals].sort((a, b) => dealSortDate(b).localeCompare(dealSortDate(a)));
  const total = tasks.length, open = tasks.filter(t => t.state !== 'done' && t.state !== 'deferred' && t.state !== 'declined').length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="text-[12px] text-[var(--color-text-muted)]">
        {loading ? 'Загружаем задачи…' : `Задач по сделкам: ${total}${open ? `, открытых ${open}` : ''}. Свежие сверху; результат задачи — последний «Результат» в Битриксе.`}
      </div>
      {list.map(d => <DealBlock key={d.dealId} d={d} tasks={(byDeal.get(d.dealId) ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt))} />)}
      {loose.length > 0 && (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-2">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Задачи без сделки в карточке · {loose.length}</div>
          <div className="divide-y divide-[var(--color-border)]">{loose.map(t => <TaskRow key={t.taskId} t={t} />)}</div>
        </div>
      )}
    </div>
  );
}
