import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Правка награды: вкл/выкл, имя/описание/иконка, пороги в criteria (jsonb).
// Конструктора НОВЫХ наград на этапе 1 нет — только правка существующих.
// + prices (задача 2657): {tier|'-': цена} — upsert в badge_prices. Меняет
// ТОЛЬКО будущие начисления: леджер хранит price_at_award (принцип леджера).
export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const { key } = await params;
  let body: { enabled?: unknown; name?: unknown; description?: unknown; icon?: unknown; criteria?: unknown; prices?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (sql: string, v: unknown) => { vals.push(v); sets.push(`${sql} = $${vals.length}`); };

  if (typeof body.enabled === 'boolean') push('enabled', body.enabled);
  if (typeof body.name === 'string' && body.name.trim()) push('name', body.name.trim().slice(0, 200));
  if (typeof body.description === 'string') push('description', body.description.slice(0, 1000));
  if (typeof body.icon === 'string' && body.icon.trim()) push('icon', body.icon.trim().slice(0, 16));
  if (body.criteria !== undefined) {
    if (typeof body.criteria !== 'object' || body.criteria === null || Array.isArray(body.criteria)) {
      return NextResponse.json({ error: 'criteria: объект' }, { status: 400 });
    }
    // числовые пороги — только конечные неотрицательные числа
    for (const [k, v] of Object.entries(body.criteria as Record<string, unknown>)) {
      if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
        return NextResponse.json({ error: `criteria.${k}: некорректное число` }, { status: 400 });
      }
    }
    push('criteria', JSON.stringify(body.criteria));
  }

  // Цены валюты (2657): prices = {'-': 50} или {bronze: 5, ..., platinum: 60}.
  let priceEntries: [string, number][] | null = null;
  if (body.prices !== undefined) {
    if (typeof body.prices !== 'object' || body.prices === null || Array.isArray(body.prices)) {
      return NextResponse.json({ error: 'prices: объект {tier: цена}' }, { status: 400 });
    }
    priceEntries = [];
    for (const [tier, v] of Object.entries(body.prices as Record<string, unknown>)) {
      if (!['-', 'bronze', 'silver', 'gold', 'platinum'].includes(tier)) {
        return NextResponse.json({ error: `prices: неизвестный уровень «${tier}»` }, { status: 400 });
      }
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000_000) {
        return NextResponse.json({ error: `prices.${tier}: целое число 0..1000000` }, { status: 400 });
      }
      priceEntries.push([tier, v]);
    }
  }

  if (sets.length === 0 && (!priceEntries || priceEntries.length === 0)) {
    return NextResponse.json({ error: 'Нет полей для сохранения' }, { status: 400 });
  }

  const db = systemDb();
  if (sets.length > 0) {
    vals.push(key);
    const res = await db.query(
      `UPDATE badge_definitions SET ${sets.join(', ')}, updated_at = now() WHERE key = $${vals.length} RETURNING key`,
      vals,
    );
    if (res.rowCount === 0) return NextResponse.json({ error: 'Награда не найдена' }, { status: 404 });
  }
  if (priceEntries && priceEntries.length > 0) {
    const exists = await db.query(`SELECT 1 FROM badge_definitions WHERE key = $1`, [key]);
    if (exists.rowCount === 0) return NextResponse.json({ error: 'Награда не найдена' }, { status: 404 });
    for (const [tier, price] of priceEntries) {
      await db.query(
        `INSERT INTO badge_prices (badge_key, tier, price) VALUES ($1, $2, $3)
         ON CONFLICT (badge_key, tier) DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
        [key, tier, price],
      );
    }
  }
  return NextResponse.json({ ok: true });
}
