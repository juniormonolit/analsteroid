import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Каталог наград для «Настройки → Награды» (задача 2655). Админский паттерн:
// как roles — только супер-админ (гейт и в layout вкладки).
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const res = await systemDb().query(
    `SELECT d.key, d.name, d.description, d.icon, d.category, d.tiered, d.criteria,
            d.enabled, d.sort_order,
            coalesce(a.awards, 0)::int AS awards,
            coalesce(a.holders, 0)::int AS holders
       FROM badge_definitions d
       LEFT JOIN (
         SELECT badge_key, count(*) AS awards, count(DISTINCT bitrix_id) AS holders
           FROM badge_awards GROUP BY badge_key
       ) a ON a.badge_key = d.key
      ORDER BY d.sort_order`,
  );
  return NextResponse.json({ rows: res.rows });
}
