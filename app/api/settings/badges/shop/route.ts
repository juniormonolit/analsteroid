import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { priceEball, priceRub } from '@/features/badges/engine/wallet';

// Управление каталогом магазина (MVP, 31.07) — админский паттерн, как штрафы.
// Цены в единицах индексации (сейчас 1 ед = 1 ебалл, задел под индексацию —
// см. wallet.ts / миграция 118). Удаления нет — только выключение (enabled),
// история покупок ссылается на позиции.

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const db = systemDb();
  const [items, settings] = await Promise.all([
    db.query(
      `SELECT i.id::int AS id, i.name, i.description, i.category, i.price_units,
              i.allowed_currencies, i.enabled, i.stock, i.ttl_months, i.sort,
              coalesce(p.purchases, 0)::int AS purchases
         FROM shop_items i
         LEFT JOIN (SELECT shop_item_id, count(*) AS purchases FROM inventory_items GROUP BY 1) p
           ON p.shop_item_id = i.id
        ORDER BY i.category, i.sort, i.id`,
    ),
    db.query<{ rate: string; ttl_months: number }>(
      `SELECT rub_to_eball_rate AS rate, ttl_months FROM badge_coin_settings WHERE id = 1`,
    ),
  ]);
  const rate = Number(settings.rows[0]?.rate ?? 1);
  return NextResponse.json({
    coinTtlMonths: settings.rows[0]?.ttl_months ?? 6,
    items: items.rows.map(i => ({
      id: i.id, name: i.name, description: i.description, category: i.category,
      priceUnits: Number(i.price_units), priceEball: priceEball(Number(i.price_units)),
      priceRub: (i.allowed_currencies as string[]).includes('RUB') ? priceRub(Number(i.price_units), rate) : null,
      allowedCurrencies: i.allowed_currencies, enabled: i.enabled, stock: i.stock,
      ttlMonths: i.ttl_months, sort: i.sort, purchases: i.purchases,
    })),
  });
}

interface ItemInput {
  name: string; description: string | null; category: 'material' | 'immaterial' | 'team';
  priceUnits: number; allowRub: boolean; stock: number | null; ttlMonths: number; sort: number;
}

function validate(body: Record<string, unknown>): ItemInput | string {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 300) : '';
  if (!name) return 'Название не может быть пустым';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 1000) || null : null;
  const category = body.category;
  if (category !== 'material' && category !== 'immaterial' && category !== 'team') {
    return 'Категория: material | immaterial | team';
  }
  const priceUnits = body.priceUnits;
  if (typeof priceUnits !== 'number' || !Number.isFinite(priceUnits) || priceUnits <= 0 || priceUnits > 1_000_000) {
    return 'Цена — число больше нуля (в единицах, сейчас 1 ед = 1 ебалл)';
  }
  const stock = body.stock === null || body.stock === undefined || body.stock === ''
    ? null : Number(body.stock);
  if (stock !== null && (!Number.isInteger(stock) || stock < 0)) return 'Сток — целое ≥ 0 или пусто (безлимит)';
  const ttlMonths = body.ttlMonths === undefined ? 3 : Number(body.ttlMonths);
  if (!Number.isInteger(ttlMonths) || ttlMonths <= 0 || ttlMonths > 60) return 'Срок годности — целое число месяцев 1–60';
  const sort = body.sort === undefined ? 100 : Number(body.sort);
  if (!Number.isInteger(sort)) return 'Сортировка — целое число';
  return { name, description, category, priceUnits, allowRub: body.allowRub === true, stock, ttlMonths, sort };
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
    `INSERT INTO shop_items (name, description, category, price_units, allowed_currencies, stock, ttl_months, sort)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [v.name, v.description, v.category, v.priceUnits, v.allowRub ? '{EBALL,RUB}' : '{EBALL}', v.stock, v.ttlMonths, v.sort],
  );
  return NextResponse.json({ ok: true, id: r.rows[0].id });
}

// PATCH: {id, ...поля} — правка позиции или переключение enabled.
export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const id = body.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return NextResponse.json({ error: 'id обязателен' }, { status: 400 });

  // Быстрый тумблер enabled без остальных полей.
  if (typeof body.enabled === 'boolean' && body.name === undefined) {
    const r = await systemDb().query(
      `UPDATE shop_items SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING id`, [id, body.enabled],
    );
    if (r.rowCount === 0) return NextResponse.json({ error: 'Позиция не найдена' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  const v = validate(body);
  if (typeof v === 'string') return NextResponse.json({ error: v }, { status: 400 });
  const r = await systemDb().query(
    `UPDATE shop_items
        SET name = $2, description = $3, category = $4, price_units = $5,
            allowed_currencies = $6, stock = $7, ttl_months = $8, sort = $9,
            enabled = coalesce($10, enabled), updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, v.name, v.description, v.category, v.priceUnits, v.allowRub ? '{EBALL,RUB}' : '{EBALL}',
     v.stock, v.ttlMonths, v.sort, typeof body.enabled === 'boolean' ? body.enabled : null],
  );
  if (r.rowCount === 0) return NextResponse.json({ error: 'Позиция не найдена' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
