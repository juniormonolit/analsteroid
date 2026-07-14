import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { analyticsDb } from '@/lib/db/clients';

// Поиск сотрудников для ручного назначения получателя (по имени / Bitrix ID /
// короткому логину). Источник — sa.org_resolved_hierarchy (живая оргструктура,
// переехала в sa 13.07; system(YC) заморожен). Из выдачи исключаем фантомные
// стабы-дубли (имя с маркером «(?)» — аккаунты без резолва, напр. Bitrix ID 1922
// «Павел Авдейчик (?)»), чтобы в пикере оставался реальный человек (напр. ID 6).

export async function GET(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2) return NextResponse.json({ employees: [] });

  const db = analyticsDb();
  const res = await db.query(
    `SELECT DISTINCT ON (manager_bitrix_user_id)
       manager_bitrix_user_id AS id, manager_name AS name, department_name, short_login
     FROM sa.org_resolved_hierarchy
     WHERE is_active
       AND manager_name NOT ILIKE '%(?)%'
       AND (manager_name ILIKE $1 OR manager_bitrix_user_id ILIKE $1 OR short_login ILIKE $1)
     ORDER BY manager_bitrix_user_id
     LIMIT 200`,
    [`%${q}%`]
  );
  // Сортировка по имени после DISTINCT ON (тот требует свой ORDER BY первым).
  const employees = res.rows
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru'))
    .slice(0, 20);
  return NextResponse.json({ employees });
}
