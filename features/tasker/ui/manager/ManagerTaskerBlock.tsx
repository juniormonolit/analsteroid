'use client';
// Блок «Задачи и обучения» в карточке менеджера (правки собрания 23.11, TASKER_FEEDBACK_2026-11-23 п.8).
// Сценарий директора: в «Базовом минимуме» видит, кто не вырос, проваливается в менеджера и сразу видит,
// были ли задачи и обучения, по какому показателю, кто вёл (теория/практика), итог +/−, и отсюда же
// «Отправить на обучение» (= форма задачи с типом «Теория»). Без section.tasker блок не рендерится.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ClipboardList, GraduationCap } from 'lucide-react';
import { hasPerm } from '@/lib/auth/perms';
import type { SessionUser } from '@/lib/auth/session';
import { TASKER_VERDICT_LABELS, type TaskerTask, type TaskerTasksResponse } from '../../types';
import { ManagerTrainingHistory } from '../../trainings/ui/ManagerTrainingHistory';
import { CreateTaskDrawer, type CreateTaskDrawerProps } from '../create/CreateTaskDrawer';
import {
  BOARD_COLUMN_LABELS, TASK_KIND_LABELS, VERDICT_CLS, addDays, boardColumn, fmtD, fmtValue, isOverdue, shortName, taskExtras, todayMsk,
} from '../shared/format';

/** Сколько назад смотреть задачи: полгода (на доске — только 60 дней итогов). */
const HISTORY_DAYS = 183;
const SHOWN = 6;

function useSession() {
  return useQuery<SessionUser | null>({
    queryKey: ['auth-session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session');
      if (!res.ok) return null;
      return (await res.json()).user ?? null;
    },
    staleTime: 60_000,
  }).data;
}

function TaskRow({ t }: { t: TaskerTask }) {
  const x = taskExtras(t);
  const col = boardColumn(t);
  const result = t.measuredValue !== null ? fmtValue(t.measuredValue, t.format) : null;
  const before = t.snapshot?.value !== undefined && t.snapshot?.value !== null ? fmtValue(t.snapshot.value, t.format) : null;
  return (
    <li>
      <Link href={`/tasker?task=${t.id}`}
        className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-[13px] hover:border-[var(--color-border-strong)]">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ClipboardList size={14} className="shrink-0 text-[var(--color-accent)]" aria-hidden />
          <b className="min-w-0 break-words">{t.kind === 'deal' ? `Сделка #${t.dealId ?? '?'}${t.deal?.title ? ` «${t.deal.title}»` : ''}` : t.metricLabel}</b>
          {x.kind && <span className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">{TASK_KIND_LABELS[x.kind]}</span>}
          {t.verdict ? (
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${VERDICT_CLS[t.verdict]}`}>
              {t.verdict === 'achieved' || t.verdict === 'improved' || t.verdict === 'deal_won' || t.verdict === 'deal_moved' ? '+ ' : t.verdict === 'no_change' || t.verdict === 'deal_stuck' || t.verdict === 'deal_lost' ? '− ' : ''}{TASKER_VERDICT_LABELS[t.verdict]}
            </span>
          ) : (
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${isOverdue(t) ? 'bg-[var(--color-negative)]/10 text-[var(--color-negative)]' : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'}`}>
              {isOverdue(t) ? 'Просрочена' : BOARD_COLUMN_LABELS[col]}
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-[var(--color-text-muted)]">
          <span>Исполнитель: {shortName((x.assignee ?? t.rop ?? t.creator).name)}</span>
          <span>Срок {fmtD(t.deadline)}</span>
          {t.kind === 'deal'
            ? t.deal && <span>{t.deal.stage ?? '—'}{t.deal.daysInStage != null ? ` · ${t.deal.daysInStage} дн.` : ''}{t.dealResult && t.dealResult.stageId !== t.deal.stageId ? ` → ${t.dealResult.stage ?? '—'}` : ''}</span>
            : <>
              {before && <span>Было {before}{result ? ` → стало ${result}` : ''}</span>}
              {!result && t.verdict === null && <span>Замер {fmtD(t.controlDate)}</span>}
            </>}
        </span>
        {x.doneNote && <span className="line-clamp-2 break-words text-[12px] text-[var(--color-text-secondary)]">Что сделано: {x.doneNote}</span>}
      </Link>
    </li>
  );
}

export function ManagerTaskerBlock({ managerId, managerName, department, period }: {
  managerId: string;
  managerName: string;
  department?: string | null;
  period?: CreateTaskDrawerProps['period'];
}) {
  const session = useSession();
  const canSee = hasPerm(session ?? null, 'section.tasker');
  const canAssign = hasPerm(session ?? null, 'action.tasker.assign');
  const [all, setAll] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const from = useMemo(() => addDays(todayMsk(), -HISTORY_DAYS), []);
  const q = useQuery({
    queryKey: ['tasker', 'manager-card', managerId, from],
    queryFn: async () => {
      // Окно по сроку/слоту/замеру: всё за полгода, включая будущие сроки.
      const r = await fetch(`/api/tasker/tasks?${new URLSearchParams({ view: 'week', managerId, from, to: '2999-12-31' })}`);
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Ошибка ${r.status}`);
      return (await r.json()) as TaskerTasksResponse;
    },
    enabled: canSee,
    staleTime: 60_000,
    retry: false,
  });

  const tasks = useMemo(
    () => [...(q.data?.tasks ?? [])].sort((a, b) => b.deadline.localeCompare(a.deadline)),
    [q.data],
  );
  const grown = tasks.filter(t => t.verdict === 'achieved' || t.verdict === 'improved').length;
  const notGrown = tasks.filter(t => t.verdict === 'no_change').length;
  const open = tasks.filter(t => !t.verdict).length;

  if (!canSee) return null;
  const shown = all ? tasks : tasks.slice(0, SHOWN);

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Задачи и обучения</div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/tasker?manager=${managerId}`}
            className="inline-flex min-h-11 items-center gap-1 px-1 text-[13px] text-[var(--color-accent)] hover:underline">
            В Задачнике <ArrowUpRight size={14} aria-hidden />
          </Link>
          {canAssign && (
            <button type="button" onClick={() => setSendOpen(true)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
              <GraduationCap size={16} aria-hidden /> Отправить на обучение
            </button>
          )}
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Задачи за полгода</h3>
            {tasks.length > 0 && (
              <span className="text-[12px] text-[var(--color-text-muted)]">
                {grown > 0 && <span className="text-[var(--color-positive)]">выросли: {grown}</span>}
                {grown > 0 && (notGrown > 0 || open > 0) && ' · '}
                {notGrown > 0 && <span className="text-[var(--color-negative)]">не выросли: {notGrown}</span>}
                {notGrown > 0 && open > 0 && ' · '}
                {open > 0 && <span>в работе/на замере: {open}</span>}
              </span>
            )}
          </div>
          {q.isLoading && <p className="text-[13px] text-[var(--color-text-muted)]">Загружаю задачи…</p>}
          {q.isError && <p className="text-[13px] text-[var(--color-negative)]">{(q.error as Error).message}</p>}
          {q.data && tasks.length === 0 && <p className="text-[13px] text-[var(--color-text-muted)]">Задач по менеджеру не было.</p>}
          {shown.length > 0 && <ul className="flex min-w-0 flex-col gap-2">{shown.map(t => <TaskRow key={t.id} t={t} />)}</ul>}
          {tasks.length > SHOWN && (
            <button type="button" onClick={() => setAll(a => !a)} className="min-h-11 w-fit text-[13px] text-[var(--color-accent)] hover:underline">
              {all ? 'Свернуть' : `Все задачи (${tasks.length})`}
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Обучения</h3>
          <ManagerTrainingHistory managerId={Number(managerId)} compact />
        </div>
      </div>

      {canAssign && (
        <CreateTaskDrawer
          open={sendOpen} onClose={() => setSendOpen(false)}
          managerIds={[managerId]}
          managerOptions={[{ value: managerId, label: managerName, hint: department ?? null }]}
          period={period}
          kind="theory"
        />
      )}
    </section>
  );
}
