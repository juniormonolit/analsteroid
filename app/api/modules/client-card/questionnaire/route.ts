import { NextRequest, NextResponse } from 'next/server';
import { moduleActor } from '@/lib/bitrix/widgetGrant';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { AnswerError, fetchClientQuestionnaire, saveManagerAnswers } from '@/features/questionnaires/engine/answers';

// Анкета заказчика в карточке клиента (миграция 249, владелец 23.10): вопросы анкет его товарных групп + общие,
// ответы менеджера и «по разговорам». Доступ — как у ручных полей карточки (moduleActor): сессия Монолитики с
// доступом к клиенту ИЛИ пропуск вкладки Битрикса на этого клиента — менеджер заполняет прямо в Битриксе.
export const dynamic = 'force-dynamic';

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);

/** GET ?contactId|companyId&groups=Газобетон|Кровля — группы, по которым показать анкеты (+ общие всегда). */
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const ref = parseClientRef(sp.get('contactId'), sp.get('companyId'));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  if (!(await moduleActor(req, ref))) return NextResponse.json({ error: 'Нет доступа — откройте карточку клиента заново' }, { status: 403 });
  const groups = (sp.get('groups') ?? '').split('|').map(x => x.trim()).filter(x => x && x.length < 120).slice(0, 60);
  try {
    const questions = await fetchClientQuestionnaire(ref, groups);
    // Цитата из расшифровки звонка у ответа «по разговорам» — только РОПу (право ИИ-анализа; владелец 26.10:
    // «транскрибации менеджер не видит»). Сам ответ — всем, кто видит карточку.
    const session = await getSession().catch(() => null);
    const full = !!session && hasPerm(session, 'action.ai_call_analysis');
    const out = full ? questions : questions.map(q => (q.ai ? { ...q, ai: { ...q.ai, quote: null } } : q));
    return NextResponse.json({ questions: out }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof AnswerError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[client-card/questionnaire]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить анкету' }, { status: 500 });
  }
}

/** PUT { contactId|companyId, answers: [{questionId, text?, options?}] } — ответы менеджера; пустой — снять. */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  const ref = parseClientRef(str(body.contactId), str(body.companyId));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  const actor = await moduleActor(req, ref);
  if (!actor) return NextResponse.json({ error: 'Нет доступа — откройте карточку клиента заново' }, { status: 403 });
  const answers = Array.isArray(body.answers) ? (body.answers as { questionId: number; text?: unknown; options?: unknown }[]).slice(0, 200) : [];
  try {
    const changed = await saveManagerAnswers(ref, answers, actor, actor);
    return NextResponse.json({ ok: true, changed });
  } catch (e) {
    if (e instanceof AnswerError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[client-card/questionnaire PUT]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось сохранить ответы' }, { status: 500 });
  }
}
