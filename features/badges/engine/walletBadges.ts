// Три ачивки по кошельку (доп. Серёги к задаче 2741, 01.08, миграция 127):
//  * «Шопоголик» (wallet_first_purchase) — первая покупка в магазине призов,
//    любым кошельком (EBALL или RUB).
//  * «Инвестор» (wallet_big_spender) — суммарно ПОТРАЧЕНО ≥1000 ебаллов,
//    валовый расход (без вычета возвратов/призов) по source IN
//    ('shop_purchase','gacha_spin','quest_reroll') — три «реальные траты EBALL»
//    (sink-mechanics.md §2.1-2.7); переводы (transfer_out) НЕ считаются.
//  * «Удачливый» (wallet_gacha_lucky) — выпал предмет rarity rare/jackpot
//    из гачи (наша шкала — common/rare/jackpot, промежуточной 'epic' нет).
//
// Все три — разовые (period_type/period_date = NULL, одна строка на менеджера
// по uq_badge_awards). Читает ту же системную БД (badge_coin_ledger, gacha_spins),
// вызывается из runBadgeRecompute ТЕМ ЖЕ клиентом (до BEGIN — обычное чтение,
// как categoryBadges/planningBadges до него).

import type { PoolClient } from 'pg';
import type { BadgeTier } from './catalog';

export interface WalletAwardRow {
  bitrixId: number; badgeKey: string; tier: BadgeTier | null;
  periodType: null; periodDate: null; value: number | null;
}

export async function computeWalletBadgeAwards(client: PoolClient): Promise<WalletAwardRow[]> {
  const awards: WalletAwardRow[] = [];

  // «Шопоголик»: хоть одна покупка в магазине (currency любая).
  const firstPurchase = await client.query<{ bitrix_id: string; n: string }>(
    `SELECT bitrix_id, count(*) AS n
       FROM badge_coin_ledger
      WHERE source = 'shop_purchase'
      GROUP BY bitrix_id`,
  );
  for (const r of firstPurchase.rows) {
    awards.push({ bitrixId: Number(r.bitrix_id), badgeKey: 'wallet_first_purchase', tier: null, periodType: null, periodDate: null, value: Number(r.n) });
  }

  // «Инвестор»: валовый расход EBALL по трём источникам >= 1000.
  const bigSpender = await client.query<{ bitrix_id: string; spent: string }>(
    `SELECT bitrix_id, sum(-amount) AS spent
       FROM badge_coin_ledger
      WHERE currency = 'EBALL' AND amount < 0
        AND source IN ('shop_purchase', 'gacha_spin', 'quest_reroll')
      GROUP BY bitrix_id
     HAVING sum(-amount) >= 1000`,
  );
  for (const r of bigSpender.rows) {
    awards.push({ bitrixId: Number(r.bitrix_id), badgeKey: 'wallet_big_spender', tier: null, periodType: null, periodDate: null, value: Number(r.spent) });
  }

  // «Удачливый»: хотя бы одна крутка rarity rare/jackpot.
  const lucky = await client.query<{ bitrix_id: string; n: string }>(
    `SELECT bitrix_id, count(*) AS n
       FROM gacha_spins
      WHERE rarity IN ('rare', 'jackpot')
      GROUP BY bitrix_id`,
  );
  for (const r of lucky.rows) {
    awards.push({ bitrixId: Number(r.bitrix_id), badgeKey: 'wallet_gacha_lucky', tier: null, periodType: null, periodDate: null, value: Number(r.n) });
  }

  return awards;
}
