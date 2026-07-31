// Внутренняя валюта за награды (задача 2657): начисление по леджеру
// badge_coin_ledger — одно начисление на награду (badge_award_id UNIQUE),
// по цене НА МОМЕНТ начисления (изменение цены в настройках не переоценивает
// прошлое — принцип леджера). Баланс = SUM по леджеру (вьюха badge_coin_balances).

import type { Pool, PoolClient } from 'pg';

export interface CoinStats {
  coinsAccrued: number;  // новых транзакций начисления
  coinsEmitted: number;  // сумма начисленного этим прогоном
}

export async function getCurrencyName(db: Pool | PoolClient): Promise<string> {
  const r = await db.query<{ currency_name: string }>(
    `SELECT currency_name FROM badge_coin_settings WHERE id = 1`,
  );
  return r.rows[0]?.currency_name ?? 'ебаллы';
}

export async function getBalances(db: Pool, bitrixIds: number[]): Promise<Map<number, number>> {
  if (bitrixIds.length === 0) return new Map();
  const r = await db.query<{ bitrix_id: number; balance: string }>(
    `SELECT bitrix_id, balance FROM badge_coin_balances WHERE bitrix_id = ANY($1::bigint[])`,
    [bitrixIds],
  );
  return new Map(r.rows.map(x => [Number(x.bitrix_id), Number(x.balance)]));
}

// Начисление за все награды без транзакции в леджере — ретро и ночные прогоны
// одной идемпотентной командой (повторный прогон = 0 новых). Вызывается из
// runBadgeRecompute в той же транзакции, что и запись наград.
export async function accrueCoins(client: PoolClient): Promise<CoinStats> {
  // Цены для наград, появившихся ПОСЛЕ сида миграции 113 (новые определения из
  // catalog.ts): дефолт 50, дальше правится в настройках. Идемпотентно.
  await client.query(
    `INSERT INTO badge_prices (badge_key, tier, price)
     SELECT d.key, t.tier, 50
       FROM badge_definitions d
      CROSS JOIN LATERAL unnest(
        CASE WHEN d.tiered THEN ARRAY['bronze','silver','gold','platinum'] ELSE ARRAY['-'] END
      ) AS t(tier)
     ON CONFLICT (badge_key, tier) DO NOTHING`,
  );
  const r = await client.query<{ amount: number }>(
    `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, amount, price_at_award)
     SELECT a.bitrix_id, a.id, p.price, p.price
       FROM badge_awards a
       JOIN badge_prices p ON p.badge_key = a.badge_key AND p.tier = coalesce(a.tier, '-')
       LEFT JOIN badge_coin_ledger l ON l.badge_award_id = a.id
      WHERE l.id IS NULL AND p.price > 0
     ON CONFLICT (badge_award_id) DO NOTHING
     RETURNING amount`,
  );
  return {
    coinsAccrued: r.rowCount ?? 0,
    coinsEmitted: r.rows.reduce((s, x) => s + Number(x.amount), 0),
  };
}
