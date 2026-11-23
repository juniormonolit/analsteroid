'use client';
// Данные Задачника для видов (сессия B). Контракт — features/tasker/types.ts, сервер — app/api/tasker/* (сессия A).
// ?mock=1 в dev — моковые данные (ui/shared/mock.ts), в проде флаг ничего не делает.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { enumParam, stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import type { TaskerMetricsResponse, TaskerPatchRequest, TaskerPatchResponse, TaskerTask, TaskerTasksResponse, TaskerView } from '../../types';
import { MOCK_METRICS, mockTasks } from './mock';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j && typeof j === 'object' && 'error' in j && j.error)) throw new ApiError(r.status, (j as { error?: string }).error ?? `Ошибка ${r.status}`);
  return j as T;
}

export function useMockFlag(): boolean {
  const [m] = useUrlState('mock', stringParam(''));
  return process.env.NODE_ENV !== 'production' && m === '1';
}

const MINE = ['', 'created', 'watch'] as const;
export type MineFilter = (typeof MINE)[number];

/** Общий фильтр трёх видов — в URL, чтобы ссылку можно было переслать. */
export function useTaskerFilters() {
  const [rop, setRop] = useUrlState('rop', stringParam(''));
  const [manager, setManager] = useUrlState('manager', stringParam(''));
  const [metric, setMetric] = useUrlState('metric', stringParam(''));
  const [mine, setMine] = useUrlState('mine', enumParam(MINE, ''));
  const active = !!(rop || manager || metric || mine);
  const reset = () => { setRop(''); setManager(''); setMetric(''); setMine(''); };
  return { rop, setRop, manager, setManager, metric, setMetric, mine, setMine, active, reset };
}
export type TaskerFilterState = ReturnType<typeof useTaskerFilters>;

export function tasksQueryString(view: TaskerView, range: { from: string; to: string } | null, f: Pick<TaskerFilterState, 'rop' | 'manager' | 'metric' | 'mine'>) {
  const p = new URLSearchParams({ view });
  if (range) { p.set('from', range.from); p.set('to', range.to); }
  if (f.manager) p.set('managerId', f.manager);
  if (f.rop) p.set('ropId', f.rop);
  if (f.metric) p.set('metricId', f.metric);
  if (f.mine) p.set('mine', f.mine);
  return p.toString();
}

/** Моки фильтруем на клиенте — чтобы фильтр в dev вёл себя как настоящий. */
function filterMock(d: TaskerTasksResponse, f: Pick<TaskerFilterState, 'rop' | 'manager' | 'metric'>): TaskerTasksResponse {
  const ok = (t: TaskerTask) => (!f.manager || String(t.manager.id) === f.manager) && (!f.rop || String(t.rop?.id) === f.rop) && (!f.metric || t.metricId === f.metric);
  const tasks = d.tasks.filter(ok);
  const ids = new Set(tasks.map(t => t.id));
  return {
    tasks,
    sessions: d.sessions.filter(s => s.taskIds.some(id => ids.has(id))),
    trainings: d.trainings.filter(e => !f.manager || String(e.manager.id) === f.manager),
  };
}

export const TASKS_KEY = 'tasker-tasks';

export function useTaskerTasks(view: TaskerView, range: { from: string; to: string } | null, f: TaskerFilterState, mock: boolean) {
  const qs = tasksQueryString(view, range, f);
  const queryKey = useMemo(() => [TASKS_KEY, mock ? 'mock' : '', qs], [mock, qs]);
  const q = useQuery<TaskerTasksResponse, ApiError>({
    queryKey,
    queryFn: () => (mock ? Promise.resolve(filterMock(mockTasks(), f)) : getJson<TaskerTasksResponse>(`/api/tasker/tasks?${qs}`)),
    refetchInterval: mock ? false : 60_000,
    staleTime: mock ? Infinity : 30_000,
    placeholderData: prev => prev,
  });
  return { ...q, queryKey };
}

export function useTaskerMetrics(mock: boolean) {
  return useQuery<TaskerMetricsResponse, ApiError>({
    queryKey: ['tasker-metrics', mock],
    queryFn: () => (mock ? Promise.resolve({ metrics: MOCK_METRICS, bitrixConfigured: true }) : getJson<TaskerMetricsResponse>('/api/tasker/metrics')),
    staleTime: 10 * 60_000,
  });
}

export async function patchTask(id: number, body: TaskerPatchRequest): Promise<TaskerTask> {
  const j = await getJson<TaskerPatchResponse>(`/api/tasker/tasks/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return j.task;
}
