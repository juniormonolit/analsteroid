'use client';
import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { GraduationCap } from 'lucide-react';
import type { TaskerMetric } from '../../types';
import type { TrainingHistoryItem, TrainingHistoryResponse, TrainingLogEntry } from '../types';
import { getJson } from './api';
import { AttendanceBadge, MetricChips, OutcomeBadge, ResultLines } from './EffectBits';
import { mskDayLabel, mskTime } from './format';

const LOG_LABEL: Record<TrainingLogEntry['action'], string> = {
  enroll: 'записан(а)', unenroll: 'отписан(а)', goal: 'цель обновлена', attended: 'отмечен(а): был',
  absent: 'отмечен(а): не был', attendance_cleared: 'отметка посещения снята', enroll_failed: 'не удалось записать из задачи',
};

const fmtAt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * История обучений менеджера: на что, зачем, кто отправил, был ли, что изменилось. Встраивается в карточку задачи
 * Задачника и во вкладку «Эффективность». compact — без журнала и не больше 3 последних.
 */
export function ManagerTrainingHistory({ managerId, compact = false }: { managerId: number | null; compact?: boolean }) {
  // managerId null — свои обучения (сервер берёт bitrix id сессии).
  const q = useQuery({
    queryKey: ['tasker-trainings', 'history', managerId ?? 'me'],
    queryFn: () => getJson<TrainingHistoryResponse>(`/api/tasker/trainings/history${managerId ? `?managerId=${managerId}` : ''}`),
    staleTime: 60_000,
    retry: false,
  });
  const metrics = useMemo(() => new Map((q.data?.metrics ?? []).map(m => [m.id, m])), [q.data]);
  if (q.isLoading) return <p className="text-[13px] text-[var(--color-text-muted)]">Загружаю обучения…</p>;
  if (q.isError) return compact ? null : <p className="text-[13px] text-[var(--color-negative)]">{(q.error as Error).message}</p>;
  const items = q.data?.items ?? [];
  if (!items.length) return <p className="text-[13px] text-[var(--color-text-muted)]">Обучений ещё не было.</p>;
  const shown = compact ? items.slice(0, 3) : items;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul className="flex min-w-0 flex-col gap-2">
        {shown.map(it => <HistoryItem key={it.event.id} it={it} metrics={metrics} compact={compact} />)}
      </ul>
      {compact && items.length > shown.length && (
        <Link href={`/tasker/trainings?tab=effect${managerId ? `&manager=${managerId}` : ''}`} className="inline-flex min-h-11 items-center text-[13px] text-[var(--color-accent)] underline">
          Все обучения ({items.length})
        </Link>
      )}
    </div>
  );
}

function HistoryItem({ it, metrics, compact }: { it: TrainingHistoryItem; metrics: Map<string, TaskerMetric>; compact: boolean }) {
  const started = new Date(it.event.startsAt).getTime() <= Date.now();
  return (
    <li className={`flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-[13px] ${!it.enrolled || it.event.cancelledAt ? 'opacity-70' : ''}`}>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <GraduationCap size={14} className="shrink-0 text-[var(--color-accent)]" />
        <b className={`min-w-0 break-words ${it.event.cancelledAt ? 'line-through' : ''}`}>{it.event.title}</b>
        {it.enrolled && started && !it.event.cancelledAt && <AttendanceBadge attended={it.attended} />}
        {it.outcome && <OutcomeBadge outcome={it.outcome} />}
        {!it.enrolled && <span className="text-[12px] text-[var(--color-text-muted)]">отписан(а)</span>}
      </span>
      <span className="text-[12px] text-[var(--color-text-muted)]">
        {mskDayLabel(it.event.startsAt)}, {mskTime(it.event.startsAt)}{it.event.trainer ? ` · тренер ${it.event.trainer.name}` : ''}
        {it.enrolledBy ? ` · отправил(а) ${it.enrolledBy}` : ''}{it.taskerTaskId ? ' · из задачи' : ''}
      </span>
      {it.goalMetricIds.length > 0 && <span className="flex min-w-0 flex-wrap items-center gap-1 text-[12px]">Цель: <MetricChips ids={it.goalMetricIds} metrics={metrics} /></span>}
      {it.goalNote && <span className="break-words text-[12px] text-[var(--color-text-secondary)]">«{it.goalNote}»</span>}
      <ResultLines results={it.results} metrics={metrics} />
      {!compact && it.log.length > 0 && (
        <details className="text-[12px] text-[var(--color-text-muted)]">
          <summary className="flex min-h-11 cursor-pointer items-center">Журнал ({it.log.length})</summary>
          <ul className="flex flex-col gap-0.5 pb-1">
            {it.log.map((l, i) => (
              <li key={i}>{fmtAt(l.at)} — {LOG_LABEL[l.action] ?? l.action}{l.actorName ? ` (${l.actorName})` : ''}
                {l.action === 'enroll_failed' && typeof l.details.reason === 'string' ? `: ${l.details.reason}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
