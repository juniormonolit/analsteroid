// Клиентские обёртки над API Задачника для формы постановки (сессия C).
// Контракт — features/tasker/types.ts / ai_docs/fresh_docs/TASKER_SPEC.md.
import type {
  TaskerCreateRequest, TaskerCreateResponse, TaskerCustomersResponse, TaskerMetricsResponse,
  TaskerPeriod, TaskerSessionsResponse, TaskerSnapshotResponse, TaskerTemplatesResponse,
} from '@/features/tasker/types';

export class TaskerApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new TaskerApiError(body?.error ?? `Ошибка ${res.status}`, res.status, body?.code);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const fetchMetrics = () => call<TaskerMetricsResponse>('/api/tasker/metrics');

export const fetchTemplates = (metricId: string) =>
  call<TaskerTemplatesResponse>(`/api/tasker/templates?metricId=${encodeURIComponent(metricId)}`);

export const fetchSnapshot = (managerIds: number[], metricId: string, period: TaskerPeriod) =>
  call<TaskerSnapshotResponse>('/api/tasker/snapshot', json({ managerIds, metricId, period }));

export const fetchCustomers = (managerId: number) =>
  call<TaskerCustomersResponse>(`/api/tasker/customers?managerId=${managerId}`);

export const fetchSessions = (metricId: string, from: string, to: string) =>
  call<TaskerSessionsResponse>(`/api/tasker/sessions?${new URLSearchParams({ metricId, from, to })}`);

export const createTasks = (req: TaskerCreateRequest) =>
  call<TaskerCreateResponse>('/api/tasker/tasks', json(req));

/** Список менеджеров, которым можно ставить задачи. Эндпоинта в контракте пока нет
 *  (попросили у сессии A) — 404 трактуем как «нет списка», форма берёт его из пропсов. */
export interface AssignableManager { id: number; name: string; deptName?: string | null }
export async function fetchAssignableManagers(): Promise<AssignableManager[] | null> {
  const res = await fetch('/api/tasker/managers');
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.managers) ? body.managers : null;
}

/** Ближайшие обучения (сессия D). Форма ответа ещё не зафиксирована в types.ts —
 *  читаем терпимо: { events | trainings | items } с id/title/startsAt. Нет эндпоинта → null
 *  (поле «Записать на обучение» скрыто). */
export interface TrainingOption { id: number; title: string; startsAt: string; place?: string | null }
export async function fetchUpcomingTrainings(): Promise<TrainingOption[] | null> {
  const res = await fetch(`/api/tasker/trainings?from=${encodeURIComponent(new Date().toISOString())}`);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const list: unknown = Array.isArray(body) ? body : body?.events ?? body?.trainings ?? body?.items;
  if (!Array.isArray(list)) return null;
  const now = Date.now();
  return list
    .map((e: Record<string, unknown>) => ({
      id: Number(e.id),
      title: String(e.title ?? e.topic ?? 'Обучение'),
      startsAt: String(e.startsAt ?? e.starts_at ?? ''),
      place: (e.place as string | null | undefined) ?? null,
    }))
    .filter(e => Number.isFinite(e.id) && e.startsAt && new Date(e.startsAt).getTime() >= now && !(e as { cancelled?: boolean }).cancelled)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, 30);
}
