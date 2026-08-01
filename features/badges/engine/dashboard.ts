// Дашборд «Геймификация → Дашборд» (задача 2741, бриф Серёги 01.08): сводка
// экономики ебаллов/рублей для первой вкладки настроек. Все запросы read-only
// по badge_coin_ledger (системная БД YC, system) — новых миграций не требуется,
// только индексы уже есть (idx_badge_coin_ledger_source, idx_ledger_eball_lots).
//
// Методика виджета «здоровье экономики» — owners-inbox/monolitika-sink-mechanics.md,
// разделы 2-3: доля «бесплатных» синков (гача net-оседание + нематериальный каталог
// магазина + TTL-сгорание) от месячной ЭМИССИИ, цель 25-35% (рекомендация №3).
//
// Область: все агрегаты по currency='EBALL', кроме отдельно показанного totalRub
// (рублёвый контур почти весь уходит через payout/конвертацию, не является
// частью sink-экономики ебаллов — см. migrations/116_rub_wallet.sql).

import type { Pool } from 'pg';

export interface EmissionBySource {
  auto: number;
  quest: number;
  manual: number;
  retro: number;
  total: number;
}

export interface AbsorptionBySource {
  shop: number;
  gacha: number;
  reroll: number;
  burn: number;
  commission: number;
  penalty: number;
  deposit: number;
  total: number;
}

export interface GamificationHealth {
  emission: number;
  absorption: number;
  freeSinkAmount: number;
  freeSinkShare: number | null; // 0..1, null если эмиссия за месяц = 0
  toBurn30d: number;
}

export interface BalanceRow {
  bitrixId: number;
  eball: number;
  rub: number;
  earned30: number;
  spent30: number;
}

const MONTH_START = `date_trunc('month', now())`;
const PREV_MONTH_START = `date_trunc('month', now() - interval '1 month')`;

async function emissionSince(db: Pool, fromExpr: string, toExpr: string): Promise<EmissionBySource> {
  const r = await db.query<{ auto: string; quest: string; manual: string; retro: string }>(
    `SELECT
       coalesce(sum(amount) FILTER (WHERE source = 'auto'), 0) AS auto,
       coalesce(sum(amount) FILTER (WHERE source IN ('quest', 'quest_extra')), 0) AS quest,
       coalesce(sum(amount) FILTER (WHERE source = 'manual_bonus'), 0) AS manual,
       coalesce(sum(amount) FILTER (WHERE source = 'release_grant'), 0) AS retro
       FROM badge_coin_ledger
      WHERE currency = 'EBALL' AND amount > 0
        AND created_at >= ${fromExpr} AND created_at < ${toExpr}`,
  );
  const row = r.rows[0];
  const auto = Number(row?.auto ?? 0), quest = Number(row?.quest ?? 0);
  const manual = Number(row?.manual ?? 0), retro = Number(row?.retro ?? 0);
  return { auto, quest, manual, retro, total: auto + quest + manual + retro };
}

async function absorptionSince(db: Pool, fromExpr: string, toExpr: string): Promise<{ abs: AbsorptionBySource; freeSinkAmount: number }> {
  // Нетто по категориям: покупка/крутка/депозит (отрицательные) минус
  // возврат/приз/погашение (положительные той же природы) — «сколько реально
  // осело», а не валовый оборот.
  const r = await db.query<{
    shop: string; gacha: string; reroll: string; burn: string;
    commission: string; penalty: string; deposit: string; immaterial: string;
  }>(
    `SELECT
       coalesce(-sum(amount) FILTER (WHERE source = 'shop_purchase'), 0)
         - coalesce(sum(amount) FILTER (WHERE source = 'shop_refund'), 0) AS shop,
       coalesce(-sum(amount) FILTER (WHERE source = 'gacha_spin'), 0)
         - coalesce(sum(amount) FILTER (WHERE source = 'gacha_prize'), 0) AS gacha,
       coalesce(-sum(amount) FILTER (WHERE source = 'quest_reroll'), 0) AS reroll,
       coalesce(-sum(amount) FILTER (WHERE source = 'expiry'), 0) AS burn,
       coalesce(-sum(amount) FILTER (WHERE source = 'transfer_fee'), 0) AS commission,
       coalesce(-sum(amount) FILTER (WHERE source = 'manual_penalty'), 0) AS penalty,
       coalesce(-sum(amount) FILTER (WHERE source IN ('contract_deposit', 'contract_deposit_return')), 0) AS deposit,
       0 AS immaterial
       FROM badge_coin_ledger
      WHERE currency = 'EBALL'
        AND created_at >= ${fromExpr} AND created_at < ${toExpr}`,
  );
  const im = await db.query<{ immaterial: string }>(
    `SELECT coalesce(-sum(l.amount), 0) AS immaterial
       FROM badge_coin_ledger l
       JOIN inventory_items ii ON ii.id = l.inventory_item_id
       JOIN shop_items si ON si.id = ii.shop_item_id
      WHERE l.currency = 'EBALL' AND l.source IN ('shop_purchase', 'shop_refund')
        AND si.category = 'immaterial'
        AND l.created_at >= ${fromExpr} AND l.created_at < ${toExpr}`,
  );
  const row = r.rows[0];
  const shop = Number(row?.shop ?? 0), gacha = Number(row?.gacha ?? 0);
  const reroll = Number(row?.reroll ?? 0), burn = Number(row?.burn ?? 0);
  const commission = Number(row?.commission ?? 0), penalty = Number(row?.penalty ?? 0);
  const deposit = Number(row?.deposit ?? 0);
  const immaterial = Number(im.rows[0]?.immaterial ?? 0);
  return {
    abs: { shop, gacha, reroll, burn, commission, penalty, deposit, total: shop + gacha + reroll + burn + commission + penalty + deposit },
    // «Бесплатные» синки (sink-mechanics.md §2.3/2.4, §4 рек.№3): гача net-оседание +
    // нематериальный каталог + TTL-сгорание — почти нулевая себестоимость компании.
    freeSinkAmount: gacha + immaterial + burn,
  };
}

export async function getMonthlyEmission(db: Pool): Promise<EmissionBySource> {
  return emissionSince(db, MONTH_START, 'now()');
}

export async function getPrevMonthlyEmission(db: Pool): Promise<EmissionBySource> {
  return emissionSince(db, PREV_MONTH_START, MONTH_START);
}

export async function getMonthlyAbsorption(db: Pool): Promise<{ abs: AbsorptionBySource; freeSinkAmount: number }> {
  return absorptionSince(db, MONTH_START, 'now()');
}

export async function getCirculation(db: Pool): Promise<{ totalEball: number; totalRub: number }> {
  const r = await db.query<{ eball: string; rub: string }>(
    `SELECT
       coalesce(sum(amount) FILTER (WHERE currency = 'EBALL'), 0) AS eball,
       coalesce(sum(amount) FILTER (WHERE currency = 'RUB'), 0) AS rub
       FROM badge_coin_ledger`,
  );
  return { totalEball: Number(r.rows[0]?.eball ?? 0), totalRub: Number(r.rows[0]?.rub ?? 0) };
}

// Баланс + заработано/потрачено ебаллов за 30 дней, по всем bitrix_id, у которых
// есть хоть одна строка в леджере (нулевые с рождения менеджеры сюда не попадают —
// на UI роутер докладывает недостающих из ростера нулями).
export async function getBalanceRows(db: Pool): Promise<BalanceRow[]> {
  const r = await db.query<{ bitrix_id: string; eball: string; rub: string; earned30: string; spent30: string }>(
    `SELECT bitrix_id,
            coalesce(sum(amount) FILTER (WHERE currency = 'EBALL'), 0) AS eball,
            coalesce(sum(amount) FILTER (WHERE currency = 'RUB'), 0) AS rub,
            coalesce(sum(amount) FILTER (WHERE currency = 'EBALL' AND amount > 0 AND created_at >= now() - interval '30 days'), 0) AS earned30,
            coalesce(-sum(amount) FILTER (WHERE currency = 'EBALL' AND amount < 0 AND created_at >= now() - interval '30 days'), 0) AS spent30
       FROM badge_coin_ledger
      GROUP BY bitrix_id`,
  );
  return r.rows.map(x => ({
    bitrixId: Number(x.bitrix_id),
    eball: Number(x.eball),
    rub: Number(x.rub),
    earned30: Number(x.earned30),
    spent30: Number(x.spent30),
  }));
}
