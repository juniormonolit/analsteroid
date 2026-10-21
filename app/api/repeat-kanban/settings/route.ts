import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canManageRepeatKanbanSettings } from '@/lib/auth/modulesAccess';
import {
  SettingsError, fetchKanbanSettings, saveKanbanSettings, listTemplates,
  createTemplate, updateTemplate, deleteTemplate,
} from '@/features/repeat-kanban/engine/settings';

// Настройки канбана повторных (владелец 21.10): норма активных задач на менеджера и
// шаблоны сообщений к задаче. Читать — всем с доступом к доске (норма нужна доске,
// шаблоны — окну постановки задачи); менять — только админам (canManageRepeatKanbanSettings).
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

async function state(session: SessionUser) {
  const [settings, templates] = await Promise.all([fetchKanbanSettings(), listTemplates().catch(e => {
    console.warn('[repeat-kanban settings] шаблоны недоступны:', e instanceof Error ? e.message : e);
    return [];
  })]);
  return { settings, templates, canManage: canManageRepeatKanbanSettings(session) };
}

function fail(e: unknown, what: string) {
  if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: 400 });
  console.error(`[repeat-kanban settings] ${what}:`, e instanceof Error ? e.message : e);
  const missing = e instanceof Error && /relation .* does not exist/i.test(e.message);
  return NextResponse.json({ error: missing ? 'Таблицы настроек ещё не созданы (миграция 233)' : `Не удалось ${what}` }, { status: 500 });
}

async function guard(write: boolean): Promise<SessionUser | NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Нет доступа к канбану повторных' }, { status: 403 });
  if (write && !canManageRepeatKanbanSettings(session)) return NextResponse.json({ error: 'Настройки канбана меняют только администраторы' }, { status: 403 });
  return session;
}

const actor = (s: SessionUser) => s.login || s.displayName || s.id;
const parseId = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

async function body(req: NextRequest): Promise<Record<string, unknown> | null> {
  const b = await req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null;
}

export async function GET() {
  const s = await guard(false);
  if (s instanceof NextResponse) return s;
  try {
    return NextResponse.json(await state(s), { headers: NO_STORE });
  } catch (e) { return fail(e, 'прочитать настройки'); }
}

/** PUT { settings: { managerTaskLimit } } — общие настройки;
 *  PUT { template: { id, name?, body?, isDefault? } } — правка шаблона. */
export async function PUT(req: NextRequest) {
  const s = await guard(true);
  if (s instanceof NextResponse) return s;
  const b = await body(req);
  if (!b) return NextResponse.json({ error: 'Пустой запрос' }, { status: 400 });
  try {
    if (b.settings && typeof b.settings === 'object') {
      await saveKanbanSettings(b.settings as Record<string, unknown>, actor(s));
    }
    if (b.template && typeof b.template === 'object') {
      const t = b.template as Record<string, unknown>;
      const id = parseId(t.id);
      if (!id) return NextResponse.json({ error: 'Не указан шаблон' }, { status: 400 });
      await updateTemplate(id, { name: t.name, body: t.body, isDefault: t.isDefault }, actor(s));
    }
    if (!b.settings && !b.template) return NextResponse.json({ error: 'Нечего сохранять' }, { status: 400 });
    return NextResponse.json(await state(s), { headers: NO_STORE });
  } catch (e) { return fail(e, 'сохранить'); }
}

/** POST { name, body, isDefault? } — новый шаблон. */
export async function POST(req: NextRequest) {
  const s = await guard(true);
  if (s instanceof NextResponse) return s;
  const b = await body(req);
  if (!b) return NextResponse.json({ error: 'Пустой запрос' }, { status: 400 });
  try {
    const created = await createTemplate({ name: b.name, body: b.body, isDefault: b.isDefault }, actor(s));
    return NextResponse.json({ ...(await state(s)), created }, { headers: NO_STORE });
  } catch (e) { return fail(e, 'создать шаблон'); }
}

/** DELETE ?id= — удалить шаблон. */
export async function DELETE(req: NextRequest) {
  const s = await guard(true);
  if (s instanceof NextResponse) return s;
  const id = parseId(req.nextUrl.searchParams.get('id'));
  if (!id) return NextResponse.json({ error: 'Не указан шаблон' }, { status: 400 });
  try {
    await deleteTemplate(id);
    return NextResponse.json(await state(s), { headers: NO_STORE });
  } catch (e) { return fail(e, 'удалить шаблон'); }
}
