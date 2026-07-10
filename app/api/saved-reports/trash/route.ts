import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isReportAdmin } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import type { TrashedReport } from '@/lib/saved-reports/types';

// Корзина отчётов (бриф 09.07, п.2). Каждый видит свои удалённые личные отчёты;
// витринные удалённые («Роп монитор»/«Смекалочная») видны только admin
// (action.shared_reports.manage) — как и управление ими вообще.
//
// Автоочистка (>30 дней, п.2 спеки — «без крона»): ЛЕНИВО, прямо на этом запросе —
// перед выборкой удаляем насовсем всё, что провисело в корзине дольше 30 дней. Каждое
// обращение к списку корзины подчищает и чужой хвост (не только запрашивающего юзера) —
// это singleton-таблица без per-user партиционирования очистки, но операция дешёвая
// (индекс saved_reports_deleted_at_idx, migration 069) и идемпотентна.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  await db.query(
    `DELETE FROM saved_reports WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'`
  );

  const admin = isReportAdmin(session);
  const res = await db.query<TrashedReport>(
    `SELECT id, name, report_slug AS "reportSlug", user_login AS "userLogin",
            is_shared AS "isShared", shared_section AS "sharedSection",
            deleted_at AS "deletedAt", deleted_by AS "deletedBy"
     FROM saved_reports
     WHERE deleted_at IS NOT NULL AND (user_login = $1 OR (is_shared = true AND $2::boolean))
     ORDER BY deleted_at DESC`,
    [session.login, admin]
  );
  return NextResponse.json(res.rows);
}
