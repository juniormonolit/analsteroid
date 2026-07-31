import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { systemDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';
import { priceEball, priceRub, recomputeFifoRemaining } from '@/features/badges/engine/wallet';

// Магазин призов, MVP (31.07): витрина + покупка + свой инвентарь.
// Покупка = списание из леджера source='shop_purchase' (валюта по выбору из
// allowed_currencies позиции, RUB-цена по курсу rub_to_eball_rate) + предмет
// в inventory_items со сроком годности ttl_months позиции. Цена фиксируется
// в момент покупки (price_paid / price_at_award) — будущая индексация цен
// каталога оформленное не трогает. Гача и сезоны — НЕ в MVP.

interface ItemRow {
  id: number; name: string; description: string | null; category: string;
  price_units: string; allowed_currencies: string[]; enabled: boolean;
  stock: number | null; ttl_months: number; sort: number;
}

// GET: витрина (только enabled) + инвентарь (свой или чужой по canViewManager).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requested = req.nextUrl.searchParams.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (bitrixId && bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = systemDb();
  const [items, settings, currencyName] = await Promise.all([
    db.query<ItemRow>(
      `SELECT id::int AS id, name, description, category, price_units, allowed_currencies,
              enabled, stock, ttl_months, sort
         FROM shop_items WHERE enabled = true ORDER BY category, sort, id`,
    ),
    db.query<{ rate: string }>(`SELECT rub_to_eball_rate AS rate FROM badge_coin_settings WHERE id = 1`),
    getCurrencyName(db),
  ]);
  const rate = Number(settings.rows[0]?.rate ?? 1);

  const inventory = bitrixId
    ? await db.query(
        `SELECT id::int AS id, shop_item_id::int AS shop_item_id, item_name, price_paid, currency, status,
                to_char(purchased_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS purchased_at,
                to_char(expires_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS expires_at,
                activation_comment, resolver_login, resolve_comment, gift_history,
                to_char(resolved_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS resolved_at
           FROM inventory_items WHERE bitrix_id = $1
          ORDER BY (status IN ('owned','activation_requested')) DESC, purchased_at DESC
          LIMIT 100`,
        [Number(bitrixId)],
      )
    : { rows: [] };

  const balances = bitrixId
    ? await db.query<{ currency: string; balance: string }>(
        `SELECT currency, coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger
          WHERE bitrix_id = $1 GROUP BY currency`,
        [Number(bitrixId)],
      )
    : { rows: [] as { currency: string; balance: string }[] };
  const balanceBy = new Map(balances.rows.map(b => [b.currency, Number(b.balance)]));

  return NextResponse.json({
    currencyName,
    rate,
    balance: balanceBy.get('EBALL') ?? 0,
    rubBalance: balanceBy.get('RUB') ?? 0,
    items: items.rows.map(i => ({
      id: i.id, name: i.name, description: i.description, category: i.category,
      priceEball: priceEball(Number(i.price_units)),
      priceRub: i.allowed_currencies.includes('RUB') ? priceRub(Number(i.price_units), rate) : null,
      allowedCurrencies: i.allowed_currencies, stock: i.stock, ttlMonths: i.ttl_months,
    })),
    inventory: inventory.rows,
  });
}

// POST: покупка {itemId, currency} — только за себя (session.bitrixUserId).
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { itemId?: unknown; currency?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const itemId = body.itemId;
  if (typeof itemId !== 'number' || !Number.isInteger(itemId)) {
    return NextResponse.json({ error: 'itemId обязателен' }, { status: 400 });
  }
  const currency = body.currency === 'RUB' ? 'RUB' : 'EBALL';

  const id = Number(session.bitrixUserId);
  const db = systemDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Блокируем позицию: конкурентные покупки последней штуки со склада.
    const itemRes = await client.query<ItemRow>(
      `SELECT id::int AS id, name, description, category, price_units, allowed_currencies,
              enabled, stock, ttl_months, sort
         FROM shop_items WHERE id = $1 FOR UPDATE`,
      [itemId],
    );
    const item = itemRes.rows[0];
    if (!item || !item.enabled) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Позиция не найдена или выключена' }, { status: 404 });
    }
    if (!item.allowed_currencies.includes(currency)) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Этой валютой позицию купить нельзя' }, { status: 400 });
    }
    if (item.stock !== null && item.stock <= 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Позиция закончилась' }, { status: 400 });
    }

    const rateRes = await client.query<{ rate: string }>(
      `SELECT rub_to_eball_rate AS rate FROM badge_coin_settings WHERE id = 1`,
    );
    const rate = Number(rateRes.rows[0]?.rate ?? 1);
    const price = currency === 'RUB' ? priceRub(Number(item.price_units), rate) : priceEball(Number(item.price_units));

    const bal = await client.query<{ balance: string }>(
      `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger WHERE bitrix_id = $1 AND currency = $2`,
      [id, currency],
    );
    const balance = Number(bal.rows[0]?.balance ?? 0);
    if (price > balance) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: `Не хватает средств: цена ${price}, на балансе ${balance}` }, { status: 400 });
    }

    if (item.stock !== null) {
      await client.query(`UPDATE shop_items SET stock = stock - 1, updated_at = now() WHERE id = $1`, [itemId]);
    }
    const inv = await client.query<{ id: number }>(
      `INSERT INTO inventory_items (bitrix_id, shop_item_id, item_name, price_paid, currency, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(months => $6)) RETURNING id`,
      [id, itemId, item.name, price, currency, item.ttl_months],
    );
    const led = await client.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, comment, inventory_item_id)
       VALUES ($1, $2, $3, $4, 'shop_purchase', $5, $6) RETURNING id`,
      [id, -price, price, currency, `Покупка в магазине: ${item.name}`, inv.rows[0].id],
    );
    await client.query(`UPDATE inventory_items SET ledger_id = $2 WHERE id = $1`, [inv.rows[0].id, led.rows[0].id]);
    // FIFO (TTL ебаллов): списание расходует старейшие живые начисления —
    // точечный пересчёт остатков лотов покупателя в той же транзакции.
    if (currency === 'EBALL') await recomputeFifoRemaining(client, id);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, inventoryId: inv.rows[0].id, paid: price, currency });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
