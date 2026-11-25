import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { canManageIdleWatch } from '@/features/big-brother/ui/watch/access';
import { validateRule, type RuleBody } from '@/features/big-brother/ui/watch/shared';

// Правила сторожа МОПов (idle_watch_rules, миграция 295): N минут тишины → получатель + шаблон.

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!canManageIdleWatch(session)) return NextResponse.json({ error: 'нет доступа' }, { status: 403 });
  const b = (await req.json().catch(() => null)) as RuleBody | null;
  if (!b) return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const err = validateRule(b, true);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  const r = await systemDb().query(
    `INSERT INTO idle_watch_rules (sort_order, name, minutes_idle, recipient, fixed_bitrix_user_id, template, is_active)
     VALUES (COALESCE($1, (SELECT COALESCE(max(sort_order), 0) + 1 FROM idle_watch_rules)), $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [b.sortOrder ?? null, b.name?.trim() ?? '', b.minutesIdle, b.recipient, b.fixedBitrixUserId?.trim() || null,
      b.template ?? '', b.isActive ?? true],
  );
  return NextResponse.json({ ok: true, id: r.rows[0].id });
}
