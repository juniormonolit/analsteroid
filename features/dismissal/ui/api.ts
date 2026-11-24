'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DismissalDepartment, DismissalPlan, DismissalRunDetail, DismissalRunStatus, DismissalRunSummary, DismissalUser,
} from '../types';

// Клиент API «Увольнятора» — эндпоинты из конца features/dismissal/types.ts.

/** Ошибка API с HTTP-статусом (409 — прогон уже не в том состоянии, 400 — валидация плана). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** fetch → JSON; ошибка API ({ error }) превращается в ApiError с человеческим текстом. */
async function api<T>(url: string, init?: { method?: string; body?: unknown; keepalive?: boolean }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      keepalive: init?.keepalive,
    });
  } catch {
    throw new ApiError('Нет связи с сервером — проверьте интернет и повторите.', 0);
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* пустой/не-JSON ответ */ }
  if (!res.ok) {
    const msg = json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
      ? (json as { error: string }).error
      : res.status === 403 ? 'Нет доступа к «Увольнятору».'
      : res.status === 404 ? 'Прогон не найден.'
      : `Сервер ответил ошибкой (${res.status}).`;
    throw new ApiError(msg, res.status);
  }
  return json as T;
}

export const FINAL_STATUSES: DismissalRunStatus[] = ['done', 'failed', 'cancelled'];
const POLL_MS = 3000;

export const runKey = (id: string) => ['dismissal-run', id] as const;

export function useDismissalUsers() {
  return useQuery({
    queryKey: ['dismissal-users'],
    queryFn: () => api<{ users: DismissalUser[] }>('/api/dismissal/users').then(r => r.users),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useDismissalDepartments() {
  return useQuery({
    queryKey: ['dismissal-departments'],
    queryFn: () => api<{ departments: DismissalDepartment[] }>('/api/dismissal/departments').then(r => r.departments),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useDismissalRuns() {
  return useQuery({
    queryKey: ['dismissal-runs'],
    queryFn: () => api<{ runs: DismissalRunSummary[] }>('/api/dismissal/runs').then(r => r.runs),
    // Пока что-то собирается или исполняется — список обновляется сам (счётчики done/error).
    refetchInterval: q => (q.state.data ?? []).some(r => r.status === 'scanning' || r.status === 'queued' || r.status === 'running') ? 5000 : false,
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceBitrixId: number) => api<{ id: string; existing?: boolean }>('/api/dismissal/runs', { method: 'POST', body: { sourceBitrixId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dismissal-runs'] }),
  });
}

/** Прогон; поллинг, пока он собирается или исполняется. */
export function useDismissalRun(id: string) {
  return useQuery({
    queryKey: runKey(id),
    queryFn: () => api<DismissalRunDetail>(`/api/dismissal/runs/${encodeURIComponent(id)}`),
    refetchInterval: q => {
      const s = q.state.data?.status;
      return s === 'scanning' || s === 'queued' || s === 'running' ? POLL_MS : false;
    },
    refetchOnWindowFocus: false,
  });
}

export function savePlan(id: string, plan: DismissalPlan, opts?: { keepalive?: boolean }) {
  return api<DismissalRunDetail>(`/api/dismissal/runs/${encodeURIComponent(id)}`, { method: 'PATCH', body: { plan }, keepalive: opts?.keepalive });
}

export type RunCommand = 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'rescan';

export function useRunCommand(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cmd: RunCommand) => api<DismissalRunDetail>(`/api/dismissal/runs/${encodeURIComponent(id)}/${cmd}`, { method: 'POST' }),
    onSuccess: detail => {
      qc.setQueryData(runKey(id), detail);
      qc.invalidateQueries({ queryKey: ['dismissal-runs'] });
    },
    // 409 — прогон уже в другом состоянии (сменили в соседней вкладке): перечитываем.
    onError: e => { if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: runKey(id) }); },
  });
}
