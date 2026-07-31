import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Управление справочником штрафов (доп. Серёги 31.07) — админский паттерн, как
// остальные настройки наград. price_mode: 'fixed' (сумма) | 'percent' (% от
// накопленного баланса на момент штрафа, для особых косяков).

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const db = systemDb();
  const [types, settings] = await Promise.all([
    db.query(
      `SELECT t.id::int AS id, t.name, t.price, t.price_mode, t.enabled,
              coalesce(u.uses, 0)::int AS uses
         FROM penalty_types t
         LEFT JOIN (SELECT penalty_type_id, count(*) AS uses FROM badge_coin_ledger GROUP BY 1) u
           ON u.penalty_type_id = t.id
        ORDER BY t.name`,
    ),
    db.query<{ monthly_bonus_budget: number }>(`SELECT monthly_bonus_budget FROM badge_coin_settings WHERE id = 1`),
  ]);
  return NextResponse.json({
    types: types.rows,
    monthlyBonusBudget: settings.rows[0]?.monthly_bonus_budget ?? 2000,
  });
}

function validate(body: { name?: unknown; price?: unknown; priceMode?: unknown }): { name: string; price: number; priceMode: 'fixed' | 'percent' } | string {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 300) : '';
  if (!name) return 'Название причины не может быть пустым';
  const priceMode = body.priceMode === 'percent' ? 'percent' as const : 'fixed' as const;
  const price = body.price;
  if (typeof price !== 'number' || !Number.isInteger(price) || price <= 0) return 'Размер — целое число больше нуля';
  if (priceMode === 'percent' && price > 100) return 'Процент не может быть больше 100';
  if (priceMode === 'fixed' && price > 1_000_000) return 'Слишком большая сумма';
  return { name, price, priceMode };
}

export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const v = validate(body);
  if (typeof v === 'string') return NextResponse.json({ error: v }, { status: 400 });
  const r = await systemDb().query<{ id: number }>(
    `INSERT INTO penalty_types (name, price, price_mode) VALUES ($1, $2, $3) RETURNING id`,
    [v.name, v.price, v.priceMode],
  );
  return NextResponse.json({ ok: true, id: r.rows[0].id });
}
