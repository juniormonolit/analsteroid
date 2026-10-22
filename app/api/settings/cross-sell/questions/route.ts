import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import {
  COMMON_GROUP, QuestionnaireError, fetchQuestionnaires, normalizeQuestions, saveQuestionnaire,
} from '@/features/questionnaires/engine/questions';

// «Что предложить» → «Анкеты»: вопросы по товарным группам (миграция 244, владелец 22.10).
// Доступ — как у самого раздела: админ ИЛИ право section.cross_sell.
export const dynamic = 'force-dynamic';

async function guard() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.cross_sell')) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

/** Все анкеты: группа → вопросы (данных немного — десятки групп по десятку вопросов). */
export async function GET() {
  const g = await guard();
  if (g.error) return g.error;
  try {
    const map = await fetchQuestionnaires();
    return NextResponse.json({ questionnaires: Object.fromEntries(map), commonGroup: COMMON_GROUP }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[cross-sell questions]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить анкеты' }, { status: 500 });
  }
}

/** Сохранить анкету группы целиком: { group, questions }. */
export async function PUT(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => null) as { group?: unknown; questions?: unknown } | null;
  const group = typeof body?.group === 'string' ? body.group.trim() : '';
  if (!group || group.length > 120) return NextResponse.json({ error: 'Не указана товарная группа' }, { status: 400 });
  try {
    const questions = normalizeQuestions(body?.questions);
    const saved = await saveQuestionnaire(group, questions, g.session.displayName || g.session.login);
    return NextResponse.json({ ok: true, group, questions: saved });
  } catch (e) {
    if (e instanceof QuestionnaireError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[cross-sell questions PUT]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось сохранить анкету' }, { status: 500 });
  }
}
