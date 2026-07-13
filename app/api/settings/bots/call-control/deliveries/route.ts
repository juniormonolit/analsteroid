import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Последние доставки бота «Контроль звонков» — для проверки работы в админке.

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const db = systemDb();
  const res = await db.query(
    `SELECT d.id, d.case_id, d.rule_id, r.name AS rule_name, d.recipient_kind,
            d.recipient_bitrix_user_id, d.recipient_name, d.message, d.dry_run,
            d.mirrored, d.error, d.sent_at,
            c.phone_normalized, c.missed_count
     FROM call_control_deliveries d
     LEFT JOIN call_control_rules r ON r.id = d.rule_id
     LEFT JOIN call_control_cases c ON c.id = d.case_id
     ORDER BY d.sent_at DESC
     LIMIT 50`
  );
  return NextResponse.json({ deliveries: res.rows });
}
