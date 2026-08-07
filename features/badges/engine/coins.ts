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
  return r.rows[0]?.currency_name ?? 'MLT';
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
  const hasSkills = (await client.query<{ t: string | null }>(
    `SELECT to_regclass('skill_levels')::text AS t`,
  )).rows[0]?.t !== null;
  const skillJoin = hasSkills
    ? `LEFT JOIN LATERAL (
         SELECT 1 + 0.01 * sum((level >= 2)::int + (level >= 5)::int + (level >= 9)::int
                             + (level >= 14)::int + (level >= 20)::int) AS m
           FROM skill_levels sl WHERE sl.bitrix_id = a.bitrix_id
       ) sm ON true`
    : '';
  // Без таблицы уровней ссылки на sm.m в SELECT быть не должно — иначе тот же
  // «column does not exist» на парсинге, от которого мы и уходим.
  const skillMult = hasSkills ? 'coalesce(sm.m, 1)' : '1';
  const r = await client.query<{ amount: number }>(
    // badge_key — снимок для аудита (миграция 114): при удалении кастомной
    // награды её awards каскадно уходят, ссылка леджера остаётся NULL,
    // но начисленное остаётся и видно, за что было.
    // currency (миграция 116): «Ежедневный бонус» может начислять РУБЛИ
    // (criteria.currency='RUB') — второй кошелёк; всё остальное — ебаллы.
    // Индексация магазина (будущая) считается ТОЛЬКО по EBALL+auto.
    // Множитель MLT за пройденные пороги веток (задача 49): +1 % за порог,
    // до +5 % на полностью прокачанной. Решение владельца: добавка намеренно
    // символическая — «основное всё-таки опыт». Идёт в `amount`, но НЕ в
    // `price_at_award`: там остаётся цена награды, иначе аудит «сколько стоила
    // награда» перестанет сходиться с прайсом.
    // Таблицы skill_levels может не быть (миграция 166 накатывается вручную и
    // отдельно на каждую БД). Проверяем ДО составления запроса: Postgres
    // разбирает SQL целиком, и ссылка на несуществующую таблицу уронила бы
    // начисление даже под `to_regclass(...) IS NOT NULL` в условии join.
    `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency)
     SELECT a.bitrix_id, a.id, a.badge_key,
            GREATEST(1, round(p.price * ${skillMult})::int), p.price,
            CASE WHEN d.criteria->>'currency' = 'RUB' THEN 'RUB' ELSE 'EBALL' END
       FROM badge_awards a
       JOIN badge_definitions d ON d.key = a.badge_key
       JOIN badge_prices p ON p.badge_key = a.badge_key AND p.tier = coalesce(a.tier, '-')
       LEFT JOIN badge_coin_ledger l ON l.badge_award_id = a.id
       ${skillJoin}
      WHERE l.id IS NULL AND p.price > 0
     ON CONFLICT (badge_award_id) DO NOTHING
     RETURNING amount`,
  );
  return {
    coinsAccrued: r.rowCount ?? 0,
    coinsEmitted: r.rows.reduce((s, x) => s + Number(x.amount), 0),
  };
}
