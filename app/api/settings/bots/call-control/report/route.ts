import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Отчёт бота «Контроль звонков» по менеджерам (задача Иосифа 14.07: «кто самый
// безответственный»). «Сработавший кейс» = была хотя бы одна БОЕВАЯ доставка
// (dry_run НЕ считаем: перезвонил до 30-минутного правила — не безответственность).
// Этап кейса = максимальный sort_order сработавшего правила (1..4+, эксклюзивные
// бакеты, сумма бакетов = «всего»). Время без перезвона = от первого пропуска до
// резолва (для открытых — до сейчас). Период — полуинтервал [from, to+1день) МСК,
// как во всём конструкторе. ?managerId=N — дрилл-даун: список кейсов менеджера.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function mskBounds(from: string, to: string): [string, string] {
  // Даты МСК → границы полуинтервала. to+1day считаем на уровне SQL (interval).
  return [`${from}T00:00:00+03:00`, `${to}T00:00:00+03:00`];
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const from = req.nextUrl.searchParams.get('from') ?? '';
  const to = req.nextUrl.searchParams.get('to') ?? '';
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from/to: YYYY-MM-DD' }, { status: 400 });
  }
  const [fromTs, toTs] = mskBounds(from, to);
  const managerId = req.nextUrl.searchParams.get('managerId');

  const db = systemDb();

  // Дрилл-даун: кейсы одного менеджера.
  if (managerId) {
    if (!/^\d+$/.test(managerId)) return NextResponse.json({ error: 'managerId: число' }, { status: 400 });
    const cases = await db.query(
      `SELECT c.id, c.phone_normalized, c.deal_id, c.status, c.missed_count,
              c.first_missed_at, c.resolved_at,
              COALESCE(max(r.sort_order), 1) AS max_stage,
              EXTRACT(EPOCH FROM COALESCE(c.resolved_at, now()) - c.first_missed_at)::bigint AS seconds
       FROM call_control_cases c
       JOIN call_control_deliveries d ON d.case_id = c.id AND NOT d.dry_run
       LEFT JOIN call_control_rules r ON r.id = d.rule_id
       WHERE c.manager_bitrix_user_id = $1
         AND c.first_missed_at >= $2::timestamptz
         AND c.first_missed_at < $3::timestamptz + interval '1 day'
       GROUP BY c.id
       ORDER BY c.first_missed_at DESC`,
      [managerId, fromTs, toTs]
    );
    return NextResponse.json({ cases: cases.rows });
  }

  const rows = await db.query(
    `WITH fired AS (
       SELECT c.id, c.manager_bitrix_user_id, c.first_missed_at, c.resolved_at,
              LEAST(COALESCE(max(r.sort_order), 1), 4) AS stage,
              EXTRACT(EPOCH FROM COALESCE(c.resolved_at, now()) - c.first_missed_at) AS seconds
       FROM call_control_cases c
       JOIN call_control_deliveries d ON d.case_id = c.id AND NOT d.dry_run
       LEFT JOIN call_control_rules r ON r.id = d.rule_id
       WHERE c.first_missed_at >= $1::timestamptz
         AND c.first_missed_at < $2::timestamptz + interval '1 day'
       GROUP BY c.id
     ),
     agg AS (
       SELECT manager_bitrix_user_id,
              count(*) FILTER (WHERE stage = 1) AS s1,
              count(*) FILTER (WHERE stage = 2) AS s2,
              count(*) FILTER (WHERE stage = 3) AS s3,
              count(*) FILTER (WHERE stage = 4) AS s4,
              count(*) AS total,
              sum(seconds)::bigint AS seconds
       FROM fired GROUP BY 1
     ),
     names AS (
       SELECT DISTINCT ON (manager_bitrix_user_id)
         manager_bitrix_user_id, manager_name, short_login, department_name
       FROM org_resolved_hierarchy
       ORDER BY manager_bitrix_user_id, is_active DESC
     )
     SELECT a.*, n.manager_name, n.short_login, n.department_name
     FROM agg a
     LEFT JOIN names n ON n.manager_bitrix_user_id = a.manager_bitrix_user_id
     ORDER BY a.seconds DESC`,
    [fromTs, toTs]
  );
  return NextResponse.json({ rows: rows.rows });
}
