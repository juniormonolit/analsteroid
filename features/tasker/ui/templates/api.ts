// Клиент API конструктора шаблонов рекомендаций (app/api/tasker/templates*).
import type {
  TaskerTemplateFull, TaskerTemplateImageResponse, TaskerTemplateSaveRequest, TaskerTemplatesFullResponse,
} from '@/features/tasker/types';

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Ошибка ${res.status}`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const TEMPLATES_FULL_KEY = ['tasker', 'templates-full'] as const;

export const fetchTemplatesFull = () => call<TaskerTemplatesFullResponse>('/api/tasker/templates?all=1');

export const createTemplate = (req: TaskerTemplateSaveRequest) =>
  call<{ template: TaskerTemplateFull }>('/api/tasker/templates', json('POST', req));

export const updateTemplate = (id: number, req: TaskerTemplateSaveRequest) =>
  call<{ template: TaskerTemplateFull }>(`/api/tasker/templates/${id}`, json('PATCH', req));

export const deleteTemplate = (id: number) => call<{ ok: true }>(`/api/tasker/templates/${id}`, { method: 'DELETE' });

export const reorderTemplates = (metricId: string, ids: number[]) =>
  call<{ ok: true }>('/api/tasker/templates', json('POST', { action: 'reorder', metricId, ids }));

export function uploadTemplateImage(file: File): Promise<TaskerTemplateImageResponse> {
  const fd = new FormData();
  fd.append('file', file);
  return call<TaskerTemplateImageResponse>('/api/tasker/templates/images', { method: 'POST', body: fd });
}
