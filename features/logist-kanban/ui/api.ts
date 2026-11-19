'use client';
// Клиентские вызовы API канбана запросов логистам (контракт — engine/requests/contract.ts, спека — раздел «API»).
import type { ActionBody, ActionResponse, ApiError, PostMessageResponse } from '../engine/requests/contract';

export class LogistApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function lkFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({})) as Partial<ApiError> & T;
  if (!r.ok) {
    const msg = r.status === 409 && j.code === 'conflict'
      ? 'Запрос уже изменился — обновил карточку, проверьте и повторите'
      : j.error || `Ошибка ${r.status}`;
    throw new LogistApiError(r.status, msg, j.code);
  }
  return j;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const postAction = (id: number, body: ActionBody) =>
  lkFetch<ActionResponse>(`/api/logist-kanban/request/${id}/action`, json('POST', body));

export const postMessage = (id: number, text: string) =>
  lkFetch<PostMessageResponse>(`/api/logist-kanban/request/${id}/messages`, json('POST', { body: text }));

export const putJson = <T,>(url: string, body: unknown) => lkFetch<T>(url, json('PUT', body));
export const postJson = <T,>(url: string, body?: unknown) => lkFetch<T>(url, json('POST', body ?? {}));
