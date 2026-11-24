'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DismissalDepartment, DismissalPlan, DismissalRunDetail, DismissalRunStatus, DismissalRunSummary, DismissalUser,
} from '../types';

// Клиент API «Увольнятора» — эндпоинты из конца features/dismissal/types.ts.

/** fetch → JSON; ошибка API ({ error }) превращается в Error с человеческим текстом. */
async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error('Нет связи с сервером — проверьте интернет и повторите.');
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* пустой/не-JSON ответ */ }
  if (!res.ok) {
    const msg = json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
      ? (json as { error: string }).error
      : res.status === 403 ? 'Нет доступа к «Увольнятору».'
      : res.status === 404 ? 'Прогон не найден.'
      : `Сервер ответил ошибкой (${res.status}).`;
    throw new Error(msg);
  }
  return json as T;
}

export const FINAL_STATUSES: DismissalRunStatus[] = ['done', 'failed', 'cancelled'];

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
    // Пока что-то идёт — список обновляется сам (счётчики done/error).
    refetchInterval: q => (q.state.data ?? []).some(r => !FINAL_STATUSES.includes(r.status) && r.status !== 'draft' && r.status !== 'paused') ? 5000 : false,
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceBitrixId: number) => api<{ id: string }>('/api/dismissal/runs', { method: 'POST', body: { sourceBitrixId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dismissal-runs'] }),
  });
}

/** Прогон; поллинг каждые 2 с, пока он собирается или исполняется. */
export function useDismissalRun(id: string) {
  return useQuery({
    queryKey: runKey(id),
    queryFn: () => api<DismissalRunDetail>(`/api/dismissal/runs/${encodeURIComponent(id)}`),
    refetchInterval: q => {
      const s = q.state.data?.status;
      return s === 'scanning' || s === 'queued' || s === 'running' ? 2000 : false;
    },
    refetchOnWindowFocus: false,
  });
}

export function savePlan(id: string, plan: DismissalPlan) {
  return api<DismissalRunDetail>(`/api/dismissal/runs/${encodeURIComponent(id)}`, { method: 'PATCH', body: { plan } });
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
  });
}
