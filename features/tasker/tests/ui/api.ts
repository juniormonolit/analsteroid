import type {
  MyTestDetailResponse, TestAssignRequest, TestAssignResponse, TestResponse, TestSaveRequest,
} from '../types';

export const TESTS_KEY = ['tasker-tests'] as const;
export const MY_TESTS_KEY = ['tasker-tests-my'] as const;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const res = await fetch(url, { ...init, headers: isForm ? init?.headers : { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Ошибка ${res.status}`);
  return body as T;
}

export const getJson = <T,>(url: string) => call<T>(url);

export const createTest = (input: TestSaveRequest) =>
  call<TestResponse>('/api/tasker/tests', { method: 'POST', body: JSON.stringify(input) });
export const saveTest = (id: number, input: TestSaveRequest) =>
  call<TestResponse>(`/api/tasker/tests/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
export const assignTest = (id: number, req: TestAssignRequest) =>
  call<TestAssignResponse>(`/api/tasker/tests/${id}/assign`, { method: 'POST', body: JSON.stringify(req) });
export const allowRetake = (assignmentId: number, dueDays = 3) =>
  call<{ ok: true }>(`/api/tasker/tests/assignments/${assignmentId}`, { method: 'POST', body: JSON.stringify({ action: 'retake', dueDays }) });
export const cancelAssignment = (assignmentId: number) =>
  call<{ ok: true }>(`/api/tasker/tests/assignments/${assignmentId}`, { method: 'DELETE' });

export function uploadTestImage(file: File): Promise<{ id: string; url: string }> {
  const fd = new FormData();
  fd.append('file', file);
  return call('/api/tasker/tests/images', { method: 'POST', body: fd });
}

export const setTrainingTest = (eventId: number, body: { testId: number | null; afterDays?: number; dueDays?: number }) =>
  call<unknown>(`/api/tasker/tests/training/${eventId}`, { method: 'PUT', body: JSON.stringify(body) });
export const assignTrainingNow = (eventId: number) =>
  call<TestAssignResponse>(`/api/tasker/tests/training/${eventId}`, { method: 'POST' });

export const myTestAction = (id: number, action: 'start' | 'save' | 'submit', answers?: Record<string, string[]>) =>
  call<MyTestDetailResponse>(`/api/tasker/tests/my/${id}`, { method: 'POST', body: JSON.stringify({ action, answers }) });
