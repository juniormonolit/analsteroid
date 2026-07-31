import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getGachaPool, PPM_TOTAL } from '@/features/badges/engine/gacha';

// Управление пулом гачи (админ): шансы тиров (ppm), вкл/выкл, тумблер гачи.
// Валидация: сумма шансов ВКЛЮЧЁННЫХ тиров ровно 1 000 000 ppm (100%) —
// проверяется на итоговом состоянии после каждой правки. Счётчик джекпотов —
// сколько выдано за всё время (контроль стока айфона).

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const db = systemDb();
  const [pool, jackpots, settings] = await Promise.all([
    getGachaPool(db),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM gacha_spins WHERE rarity = 'jackpot'`),
    db.query<{ gacha_enabled: boolean; gacha_spin_cost: number; gacha_daily_limit: number; gacha_weekly_limit: number }>(
      `SELECT gacha_enabled, gacha_spin_cost, gacha_daily_limit, gacha_weekly_limit FROM badge_coin_settings WHERE id = 1`,
    ),
  ]);
  const s = settings.rows[0];
  return NextResponse.json({
    enabled: s?.gacha_enabled ?? true,
    spinCost: s?.gacha_spin_cost ?? 10,
    dailyLimit: s?.gacha_daily_limit ?? 5,
    weeklyLimit: s?.gacha_weekly_limit ?? 20,
    jackpotsGiven: Number(jackpots.rows[0]?.n ?? 0),
    ppmTotal: PPM_TOTAL,
    pool: pool.map(t => ({
      id: t.id, tierKey: t.tier_key, name: t.name, icon: t.icon, rarity: t.rarity,
      prizeType: t.prize_type, eballAmount: t.eball_amount, itemName: t.item_name,
      itemStock: t.item_stock, chancePpm: t.chance_ppm, enabled: t.enabled,
    })),
  });
}

// PATCH: {tier: {id, chancePpm?, enabled?, name?, eballAmount?}} — правка тира,
// либо {enabled} / {spinCost} / {limits} — глобальные настройки гачи.
export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const db = systemDb();

  if (typeof body.enabled === 'boolean' && body.tier === undefined) {
    await db.query(`UPDATE badge_coin_settings SET gacha_enabled = $1, updated_at = now() WHERE id = 1`, [body.enabled]);
    return NextResponse.json({ ok: true });
  }
  if (typeof body.spinCost === 'number') {
    if (!Number.isInteger(body.spinCost) || body.spinCost <= 0) return NextResponse.json({ error: 'Цена крутки — целое > 0' }, { status: 400 });
    await db.query(`UPDATE badge_coin_settings SET gacha_spin_cost = $1, updated_at = now() WHERE id = 1`, [body.spinCost]);
    return NextResponse.json({ ok: true });
  }
  if (typeof body.dailyLimit === 'number' || typeof body.weeklyLimit === 'number') {
    const d = body.dailyLimit; const w = body.weeklyLimit;
    if (d !== undefined && (typeof d !== 'number' || !Number.isInteger(d) || d <= 0)) return NextResponse.json({ error: 'Дневной лимит — целое > 0' }, { status: 400 });
    if (w !== undefined && (typeof w !== 'number' || !Number.isInteger(w) || w <= 0)) return NextResponse.json({ error: 'Недельный лимит — целое > 0' }, { status: 400 });
    await db.query(
      `UPDATE badge_coin_settings SET gacha_daily_limit = coalesce($1, gacha_daily_limit),
              gacha_weekly_limit = coalesce($2, gacha_weekly_limit), updated_at = now() WHERE id = 1`,
      [d ?? null, w ?? null],
    );
    return NextResponse.json({ ok: true });
  }

  // Массовая правка шансов: {tiers: [{id, chancePpm}, ...]} — единственный способ
  // поменять распределение (по одному тиру сумма 100% не сойдётся).
  if (Array.isArray(body.tiers)) {
    const items = body.tiers as { id?: unknown; chancePpm?: unknown }[];
    for (const it of items) {
      if (typeof it.id !== 'number' || typeof it.chancePpm !== 'number' ||
          !Number.isInteger(it.chancePpm) || it.chancePpm < 0 || it.chancePpm > PPM_TOTAL) {
        return NextResponse.json({ error: 'tiers: каждому нужен id и chancePpm (целое 0..1e6)' }, { status: 400 });
      }
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const it of items) {
        await client.query(`UPDATE gacha_pool SET chance_ppm = $2, updated_at = now() WHERE id = $1`, [it.id, it.chancePpm]);
      }
      const sum = await client.query<{ s: string }>(`SELECT coalesce(sum(chance_ppm), 0) AS s FROM gacha_pool WHERE enabled = true`);
      if (Number(sum.rows[0].s) !== PPM_TOTAL) {
        await client.query('ROLLBACK');
        return NextResponse.json({
          error: `Сумма шансов включённых тиров должна быть ровно 100% (1 000 000 ppm), получилось ${Number(sum.rows[0].s).toLocaleString('ru-RU')}`,
        }, { status: 400 });
      }
      await client.query('COMMIT');
      return NextResponse.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  const tier = body.tier as Record<string, unknown> | undefined;
  if (!tier || typeof tier.id !== 'number') return NextResponse.json({ error: 'tier.id обязателен' }, { status: 400 });
  const chancePpm = tier.chancePpm;
  if (chancePpm !== undefined && (typeof chancePpm !== 'number' || !Number.isInteger(chancePpm) || chancePpm < 0 || chancePpm > PPM_TOTAL)) {
    return NextResponse.json({ error: `Шанс — целое 0..${PPM_TOTAL} ppm` }, { status: 400 });
  }
  const eballAmount = tier.eballAmount;
  if (eballAmount !== undefined && (typeof eballAmount !== 'number' || !Number.isInteger(eballAmount) || eballAmount <= 0)) {
    return NextResponse.json({ error: 'Сумма ебаллов — целое > 0' }, { status: 400 });
  }
  const name = typeof tier.name === 'string' ? tier.name.trim().slice(0, 200) : undefined;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE gacha_pool
          SET chance_ppm = coalesce($2, chance_ppm),
              enabled = coalesce($3, enabled),
              name = coalesce($4, name),
              eball_amount = CASE WHEN prize_type = 'eball' THEN coalesce($5, eball_amount) ELSE eball_amount END,
              updated_at = now()
        WHERE id = $1 RETURNING id`,
      [tier.id, chancePpm ?? null, typeof tier.enabled === 'boolean' ? tier.enabled : null, name ?? null, eballAmount ?? null],
    );
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return NextResponse.json({ error: 'Тир не найден' }, { status: 404 }); }
    // Итоговая сумма включённых шансов обязана быть ровно 100%.
    const sum = await client.query<{ s: string }>(`SELECT coalesce(sum(chance_ppm), 0) AS s FROM gacha_pool WHERE enabled = true`);
    if (Number(sum.rows[0].s) !== PPM_TOTAL) {
      await client.query('ROLLBACK');
      return NextResponse.json({
        error: `Сумма шансов включённых тиров должна быть ровно 100% (1 000 000 ppm), получилось ${Number(sum.rows[0].s).toLocaleString('ru-RU')} — поправьте другой тир в той же величине`,
      }, { status: 400 });
    }
    await client.query('COMMIT');
    return NextResponse.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
