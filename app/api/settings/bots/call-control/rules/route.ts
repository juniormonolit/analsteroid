import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { validateRule, type RuleBody } from '@/lib/bots/callControlAdmin';

// Правила эскалации бота «Контроль звонков» (call_control_rules, миграция 098).
// Правило = (кол-во пропущенных подряд ≥ N) <И|ИЛИ> (минут без перезвона ≥ M) → получатель.
// Порог NULL = условие не участвует. Оба NULL — правило мёртвое (движок пропускает).

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const db = systemDb();
  const res = await db.query(
    `SELECT id, sort_order, name, missed_count_gte, minutes_without_callback, operator,
            recipient, fixed_bitrix_user_id, template_id, is_active
     FROM call_control_rules ORDER BY sort_order, id`
  );
  return NextResponse.json({ rules: res.rows });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const body = await req.json().catch(() => null) as RuleBody | null;
  if (!body) return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const invalid = validateRule(body);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const db = systemDb();
  const res = await db.query(
    `INSERT INTO call_control_rules
       (sort_order, name, missed_count_gte, minutes_without_callback, operator,
        recipient, fixed_bitrix_user_id, template_id, is_active)
     VALUES (
       COALESCE($1, (SELECT COALESCE(max(sort_order), 0) + 1 FROM call_control_rules)),
       $2, $3, $4, COALESCE($5, 'and'), COALESCE($6, 'manager'), $7, $8, COALESCE($9, true))
     RETURNING id`,
    [
      body.sortOrder ?? null, body.name ?? '', body.missedCountGte ?? null,
      body.minutesWithoutCallback ?? null, body.operator ?? null, body.recipient ?? null,
      (body.fixedBitrixUserId ?? '').trim() || null, body.templateId ?? null, body.isActive ?? null,
    ]
  );
  return NextResponse.json({ ok: true, id: res.rows[0].id });
}
