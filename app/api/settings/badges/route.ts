import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';

// Каталог наград для «Настройки → Награды» (задача 2655). Админский паттерн:
// как roles — только супер-админ (гейт и в layout вкладки).
// + Цены валюты по (badge_key, tier) и название валюты (задача 2657).
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const db = systemDb();
  const [res, currencyName] = await Promise.all([
    db.query(
      `SELECT d.key, d.name, d.description, d.icon, d.category, d.tiered, d.criteria,
              d.enabled, d.sort_order,
              coalesce(a.awards, 0)::int AS awards,
              coalesce(a.holders, 0)::int AS holders,
              coalesce(p.prices, '{}'::jsonb) AS prices
         FROM badge_definitions d
         LEFT JOIN (
           SELECT badge_key, count(*) AS awards, count(DISTINCT bitrix_id) AS holders
             FROM badge_awards GROUP BY badge_key
         ) a ON a.badge_key = d.key
         LEFT JOIN (
           SELECT badge_key, jsonb_object_agg(tier, price) AS prices
             FROM badge_prices GROUP BY badge_key
         ) p ON p.badge_key = d.key
        ORDER BY d.sort_order`,
    ),
    getCurrencyName(db),
  ]);
  return NextResponse.json({ rows: res.rows, currencyName });
}
