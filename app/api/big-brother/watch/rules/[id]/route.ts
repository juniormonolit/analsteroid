import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { canManageIdleWatch } from '@/features/big-brother/ui/watch/access';
import { validateRule, type RuleBody } from '@/features/big-brother/ui/watch/shared';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!canManageIdleWatch(session)) return NextResponse.json({ error: 'нет доступа' }, { status: 403 });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const b = (await req.json().catch(() => null)) as RuleBody | null;
  if (!b) return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const err = validateRule(b, false);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  const r = await systemDb().query(
    `UPDATE idle_watch_rules
        SET sort_order = COALESCE($2, sort_order),
            name = COALESCE($3, name),
            minutes_idle = COALESCE($4, minutes_idle),
            recipient = COALESCE($5, recipient),
            fixed_bitrix_user_id = CASE WHEN $6::boolean THEN $7 ELSE fixed_bitrix_user_id END,
            template = COALESCE($8, template),
            is_active = COALESCE($9, is_active),
            updated_at = now()
      WHERE id = $1`,
    [id, b.sortOrder ?? null, b.name?.trim() ?? null, b.minutesIdle ?? null, b.recipient ?? null,
      b.fixedBitrixUserId !== undefined, b.fixedBitrixUserId?.trim() || null, b.template ?? null, b.isActive ?? null],
  );
  if (!r.rowCount) return NextResponse.json({ error: 'правило не найдено' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!canManageIdleWatch(session)) return NextResponse.json({ error: 'нет доступа' }, { status: 403 });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  await systemDb().query(`DELETE FROM idle_watch_rules WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
