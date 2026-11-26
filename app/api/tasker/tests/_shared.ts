import { NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { getTestActor, TestError, type TestActor } from '@/features/tasker/tests/engine';

// Обвязка /api/tasker/tests/* (TASKER_SPEC «Тесты», миграция 300): единый формат ошибок + понятный 503 до наката.
function fail(tag: string, e: unknown): Response {
  if (e instanceof TestError) {
    return NextResponse.json({ error: e.message, code: e.status === 403 ? 'forbidden' : 'bad_request' }, { status: e.status });
  }
  const code = (e as { code?: string })?.code;
  if ((code === '42P01' || code === '42703') && /tasker_/.test(e instanceof Error ? e.message : '')) {
    return NextResponse.json({ error: 'Тесты ещё не развёрнуты: не применена миграция 300' }, { status: 503 });
  }
  console.error(`[tasker/tests ${tag}]`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: 'Не удалось выполнить запрос' }, { status: 500 });
}

/** Тренер/РОП: сессия + section.tasker. */
export async function withTestActor(tag: string, fn: (actor: TestActor) => Promise<Response>): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.tasker')) return NextResponse.json({ error: 'Нет доступа к Задачнику', code: 'forbidden' }, { status: 403 });
  try { return await fn(await getTestActor(session)); } catch (e) { return fail(tag, e); }
}

/** ЛК менеджера: только сессия (ЛК открыт всем вошедшим; движок пускает лишь к своим назначениям). */
export async function withSelf(tag: string, fn: (session: SessionUser) => Promise<Response>): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try { return await fn(session); } catch (e) { return fail(tag, e); }
}

export function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
export const badId = () => NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
export const NO_STORE = { 'Cache-Control': 'no-store' };
