import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { getTrainingActor, TrainingError, type TrainingActor } from '@/features/tasker/trainings/engine';

// Общая обвязка роутов /api/tasker/trainings/*: сессия + section.tasker + единый формат ошибок.
export async function withTrainingActor(
  tag: string,
  fn: (actor: TrainingActor) => Promise<Response>,
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.tasker')) return NextResponse.json({ error: 'Нет доступа к Задачнику', code: 'forbidden' }, { status: 403 });
  try {
    return await fn(await getTrainingActor(session));
  } catch (e) {
    if (e instanceof TrainingError) {
      return NextResponse.json({ error: e.message, code: e.status === 403 ? 'forbidden' : 'bad_request' }, { status: e.status });
    }
    // Миграция ещё не накачена (нет таблицы/колонки обучений) — понятный ответ вместо 500.
    const code = (e as { code?: string })?.code;
    if ((code === '42P01' || code === '42703') && /tasker_/.test(e instanceof Error ? e.message : '')) {
      return NextResponse.json({ error: 'Обучения ещё не развёрнуты: не применена миграция 275/277' }, { status: 503 });
    }
    console.error(`[tasker/trainings ${tag}]`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось выполнить запрос' }, { status: 500 });
  }
}

export function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function dateParam(v: string | null): string | null {
  return v && DATE_RE.test(v) ? v : null;
}

export const NO_STORE = { 'Cache-Control': 'no-store' };
