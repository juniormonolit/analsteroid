'use client';
// Регулярные собрания — клиентские вызовы API (app/api/tasker/meetings/*).
import { useQuery } from '@tanstack/react-query';
import type {
  TaskerMeetingInput, TaskerMeetingOptionsResponse, TaskerMeetingResponse, TaskerMeetingsResponse,
} from '../../types';
import { ApiError } from '../../ui/shared/api';

export const MEETINGS_KEY = 'tasker-meetings';

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j && typeof j === 'object' && 'error' in j && j.error)) throw new ApiError(r.status, (j as { error?: string }).error ?? `Ошибка ${r.status}`);
  return j as T;
}
const json = (method: string, body?: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

export function useMeetings(includeCancelled: boolean) {
  return useQuery<TaskerMeetingsResponse, ApiError>({
    queryKey: [MEETINGS_KEY, includeCancelled],
    queryFn: () => call<TaskerMeetingsResponse>(`/api/tasker/meetings${includeCancelled ? '?cancelled=1' : ''}`),
    staleTime: 30_000,
  });
}

export function useMeetingOptions(enabled: boolean) {
  return useQuery<TaskerMeetingOptionsResponse, ApiError>({
    queryKey: [MEETINGS_KEY, 'options'],
    queryFn: () => call<TaskerMeetingOptionsResponse>('/api/tasker/meetings/options'),
    staleTime: 10 * 60_000,
    enabled,
  });
}

export const createMeeting = (input: TaskerMeetingInput) => call<TaskerMeetingResponse>('/api/tasker/meetings', json('POST', input));
export const updateMeeting = (id: number, input: Partial<TaskerMeetingInput>) => call<TaskerMeetingResponse>(`/api/tasker/meetings/${id}`, json('PATCH', input));
export const cancelMeeting = (id: number) => call<TaskerMeetingResponse>(`/api/tasker/meetings/${id}`, json('DELETE'));
export const resyncMeeting = (id: number) => call<TaskerMeetingResponse>(`/api/tasker/meetings/${id}`, json('POST'));
export const setOccurrence = (id: number, date: string, cancelled: boolean) =>
  call<TaskerMeetingResponse>(`/api/tasker/meetings/${id}/occurrences`, json('POST', { date, cancelled }));
