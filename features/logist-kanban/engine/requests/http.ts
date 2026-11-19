// Общая обвязка роутов app/api/logist-kanban/{board,drafts,request,deal,queues,settings}.
// Доступ: любой вошедший пользователь, но ДАННЫЕ режутся видимостью (status.ts canSee / repo.ts visibilitySql):
// менеджер видит свои запросы (он их и создаёт — у роли продаж нет section.logist_kanban), логист — свои очереди,
// РОП — зону, руководитель логистики/админ — всё. Сам раздел-страница по-прежнему за section.logist_kanban (S3).
import { NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import type { ApiError } from './contract';
import { buildActor, type LogistActor } from './actor';
import { LogistError } from './repo';
import { InputError } from './validate';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export function err(error: string, status: number, code?: ApiError['code']): NextResponse {
  return NextResponse.json({ error, ...(code ? { code } : {}) } satisfies ApiError, { status, headers: NO_STORE });
}

/** Ошибка движка → ответ. Неизвестное — 500 с логом. */
export function toErrorResponse(e: unknown, tag: string): NextResponse {
  if (e instanceof LogistError) return err(e.message, e.status, e.code);
  if (e instanceof InputError) return err(e.message, 400, 'invalid');
  if ((e as { code?: string }).code === '42P01') return err('Таблицы канбана запросов ещё не созданы (миграция 267)', 503);
  console.error(`[logist-requests] ${tag}`, e);
  return err('Внутренняя ошибка', 500);
}

export async function withActor(
  tag: string, fn: (a: LogistActor, s: SessionUser) => Promise<Response>, opts: { zone?: boolean } = {},
): Promise<Response> {
  const session = await getSession();
  if (!session) return err('Unauthorized', 401);
  try {
    const actor = await buildActor(session, opts);
    return await fn(actor, session);
  } catch (e) {
    return toErrorResponse(e, tag);
  }
}

export async function jsonBody(req: Request): Promise<unknown> {
  const b = await req.json().catch(() => undefined);
  if (b === undefined) throw new InputError('Тело запроса — JSON');
  return b;
}

export function parseId(raw: string, label = 'id запроса'): number {
  if (!/^\d{1,15}$/.test(raw)) throw new InputError(`Некорректный ${label}`);
  return Number(raw);
}
