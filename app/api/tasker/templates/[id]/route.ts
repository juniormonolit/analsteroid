// Задачник: правка / архив / удаление варианта шаблона рекомендаций (право action.tasker.templates).
import { NextRequest, NextResponse } from 'next/server';
import { intParam, taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import { canManageTemplates, deleteTemplate, updateTemplate } from '@/features/tasker/engine/templates';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

async function guard(ctx: Ctx) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  if (!canManageTemplates(auth.session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const id = intParam((await ctx.params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id' }, { status: 400 });
  return { ...auth, id };
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const g = await guard(ctx);
  if (g instanceof Response) return g;
  try {
    return NextResponse.json({ template: await updateTemplate(g.session, g.id, (await req.json().catch(() => null)) ?? {}) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const g = await guard(ctx);
  if (g instanceof Response) return g;
  try {
    await deleteTemplate(g.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
