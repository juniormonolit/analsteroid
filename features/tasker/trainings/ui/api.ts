import type { TrainingEventInput, TrainingEventResponse } from '../types';

export const TRAININGS_KEY = ['tasker-trainings'] as const;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Ошибка ${res.status}`);
  return body as T;
}

export const getJson = <T,>(url: string) => call<T>(url);

export const createTraining = (input: TrainingEventInput) =>
  call<TrainingEventResponse>('/api/tasker/trainings', { method: 'POST', body: JSON.stringify(input) });

export const updateTraining = (id: number, input: Partial<TrainingEventInput>) =>
  call<TrainingEventResponse>(`/api/tasker/trainings/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const cancelTraining = (id: number) =>
  call<TrainingEventResponse>(`/api/tasker/trainings/${id}`, { method: 'DELETE' });

export const enrollManager = (id: number, managerId: number, goalMetricIds?: string[], goalNote?: string) =>
  call<TrainingEventResponse>(`/api/tasker/trainings/${id}/enroll`, {
    method: 'POST', body: JSON.stringify({ managerId, goalMetricIds, goalNote: goalNote?.trim() || null }),
  });

export const setAttendance = (id: number, managerId: number, attended: boolean | null) =>
  call<TrainingEventResponse>(`/api/tasker/trainings/${id}/attendance`, { method: 'POST', body: JSON.stringify({ managerId, attended }) });

export const unenrollManager = (id: number, managerId: number) =>
  call<TrainingEventResponse>(`/api/tasker/trainings/${id}/enroll`, { method: 'DELETE', body: JSON.stringify({ managerId }) });

export const resyncTraining = (id: number) =>
  call<TrainingEventResponse>(`/api/tasker/trainings/${id}/sync`, { method: 'POST' });
