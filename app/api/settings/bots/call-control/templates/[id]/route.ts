import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { validateTemplate, type TemplateBody } from '@/lib/bots/callControlAdmin';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });

  const body = await req.json().catch(() => null) as TemplateBody | null;
  if (!body) return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const invalid = validateTemplate(body, false);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const db = systemDb();
  const res = await db.query(
    `UPDATE call_control_templates SET
       name = COALESCE($2, name),
       body = COALESCE($3, body),
       updated_at = now()
     WHERE id = $1`,
    [id, body.name?.trim() ?? null, body.body ?? null]
  );
  if (res.rowCount === 0) return NextResponse.json({ error: 'не найдено' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });

  const db = systemDb();
  // Правила, ссылающиеся на шаблон, получат template_id = NULL (ON DELETE SET NULL) —
  // движок для них шлёт пустоту → фиксирует ошибку «шаблон не задан» в доставке.
  await db.query(`DELETE FROM call_control_templates WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
