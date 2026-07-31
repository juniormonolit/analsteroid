import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { analyticsDb } from '@/lib/db/clients';

// Реальные товарные head-группы для формы «Кросс-селл пара» конструктора наград
// (этап 2). Тот же фильтр, что у движка кросс-селла: позиции products проданных
// сделок, услуги/доставка/«Разное» исключены. Кэш в памяти — список меняется редко.

let _cache: { groups: string[]; at: number } | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  if (_cache && Date.now() - _cache.at < TTL_MS) {
    return NextResponse.json({ groups: _cache.groups });
  }
  const res = await analyticsDb().query<{ g: string }>(
    `SELECT DISTINCT p->>'head_group_name' AS g
       FROM sa.deals d, jsonb_array_elements(d.products) p
      WHERE d.sold_at IS NOT NULL
        AND coalesce(p->>'type','') <> 'услуга'
        AND (p->>'head_group_name') IS NOT NULL
        AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)'
      ORDER BY 1`,
  );
  const groups = res.rows.map(r => r.g);
  _cache = { groups, at: Date.now() };
  return NextResponse.json({ groups });
}
