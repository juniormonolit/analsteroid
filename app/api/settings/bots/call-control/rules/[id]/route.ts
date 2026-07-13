import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { validateRule, type RuleBody } from '@/lib/bots/callControlAdmin';

// PATCH/DELETE одного правила эскалации. Next 16: params — Promise.

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });

  const body = await req.json().catch(() => null) as RuleBody | null;
  if (!body) return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const invalid = validateRule(body);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  // Частичный апдейт: undefined = поле не трогаем; для nullable-порогов явный null = очистить.
  const db = systemDb();
  const res = await db.query(
    `UPDATE call_control_rules SET
       name = COALESCE($2, name),
       sort_order = COALESCE($3, sort_order),
       missed_count_gte = CASE WHEN $4 THEN $5 ELSE missed_count_gte END,
       minutes_without_callback = CASE WHEN $6 THEN $7 ELSE minutes_without_callback END,
       operator = COALESCE($8, operator),
       recipient = COALESCE($9, recipient),
       fixed_bitrix_user_id = CASE WHEN $10 THEN $11 ELSE fixed_bitrix_user_id END,
       template_id = CASE WHEN $12 THEN $13 ELSE template_id END,
       is_active = COALESCE($14, is_active),
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      body.name ?? null,
      body.sortOrder ?? null,
      'missedCountGte' in body, body.missedCountGte ?? null,
      'minutesWithoutCallback' in body, body.minutesWithoutCallback ?? null,
      body.operator ?? null,
      body.recipient ?? null,
      'fixedBitrixUserId' in body, (body.fixedBitrixUserId ?? '').trim() || null,
      'templateId' in body, body.templateId ?? null,
      body.isActive ?? null,
    ]
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
  await db.query(`DELETE FROM call_control_rules WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
