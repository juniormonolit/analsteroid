// ГАЧА (фаза 2 дизайн-дока, «го» Серёги 31.07): серверный RNG — результат
// крутки определяется ЗДЕСЬ, в транзакции, ДО анимации на фронте (анимация —
// театр, сервер — истина; фронт получает готовый tier_key и не передаёт ничего,
// что влияло бы на исход). Экономика и pity — см. migrations/120_gacha.sql.

import { randomInt } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { recomputeFifoRemaining } from './wallet';
import { createNotification, pushViaAnalitik } from './notifications';
import { getCurrencyName } from './coins';
import { spendPinRequirement } from '@/lib/auth/pin';

export const PPM_TOTAL = 1_000_000;
export const SOFT_PITY_FROM = 61;      // с 61-й крутки шанс редкого растёт
export const SOFT_PITY_STEP_PPM = 20_000; // +2 п.п. за крутку
export const HARD_PITY_AT = 80;        // 80-я крутка — гарантия редкого

export interface GachaTier {
  id: number; tier_key: string; name: string; icon: string;
  rarity: 'common' | 'rare' | 'jackpot';
  prize_type: 'eball' | 'item';
  eball_amount: number | null;
  shop_item_id: number | null;
  item_name: string | null;
  item_stock: number | null;
  item_ttl_months: number | null;
  chance_ppm: number; enabled: boolean; sort: number;
}

export interface GachaSettings {
  enabled: boolean; spinCost: number; dailyLimit: number; weeklyLimit: number;
}

export async function getGachaSettings(db: Pool | PoolClient): Promise<GachaSettings> {
  const r = await db.query<{ gacha_enabled: boolean; gacha_spin_cost: number; gacha_daily_limit: number; gacha_weekly_limit: number }>(
    `SELECT gacha_enabled, gacha_spin_cost, gacha_daily_limit, gacha_weekly_limit FROM badge_coin_settings WHERE id = 1`,
  );
  const s = r.rows[0];
  return {
    enabled: s?.gacha_enabled ?? true,
    spinCost: s?.gacha_spin_cost ?? 10,
    dailyLimit: s?.gacha_daily_limit ?? 5,
    weeklyLimit: s?.gacha_weekly_limit ?? 20,
  };
}

export async function getGachaPool(db: Pool | PoolClient): Promise<GachaTier[]> {
  const r = await db.query<GachaTier>(
    `SELECT g.id::int AS id, g.tier_key, g.name, g.icon, g.rarity, g.prize_type,
            g.eball_amount, g.shop_item_id::int AS shop_item_id, g.chance_ppm, g.enabled, g.sort,
            s.name AS item_name, s.stock AS item_stock, s.ttl_months AS item_ttl_months
       FROM gacha_pool g
       LEFT JOIN shop_items s ON s.id = g.shop_item_id
      ORDER BY g.sort, g.id`,
  );
  return r.rows;
}

// Счётчик pity: круток подряд без редкого+ (редкий/джекпот сбрасывают).
export async function getPityCount(db: Pool | PoolClient, bitrixId: number): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM gacha_spins
      WHERE bitrix_id = $1
        AND id > coalesce((SELECT max(id) FROM gacha_spins
                            WHERE bitrix_id = $1 AND rarity IN ('rare','jackpot')), 0)`,
    [bitrixId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

// Границы лимитов — по МСК-суткам/неделям.
export async function getSpinCounts(db: Pool | PoolClient, bitrixId: number): Promise<{ today: number; week: number }> {
  const r = await db.query<{ today: string; week: string }>(
    `SELECT count(*) FILTER (WHERE created_at >= date_trunc('day',  now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow') AS today,
            count(*) FILTER (WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow') AS week
       FROM gacha_spins WHERE bitrix_id = $1`,
    [bitrixId],
  );
  return { today: Number(r.rows[0]?.today ?? 0), week: Number(r.rows[0]?.week ?? 0) };
}

function weightedPick(tiers: GachaTier[]): GachaTier {
  const total = tiers.reduce((s, t) => s + t.chance_ppm, 0);
  let r = randomInt(total);
  for (const t of tiers) { r -= t.chance_ppm; if (r < 0) return t; }
  return tiers[tiers.length - 1];
}

// Выбор тира. Порядок ролла: (1) джекпот — независимый фиксированный шанс, вне
// pity; (2) hard pity 80 — гарантия редкого; (3) редкий с soft-pity-бонусом;
// (4) обычные тиры по их весам. Тиры item-призов с нулевым стоком исключаются
// (джекпот при выданном айфоне невозможен, пока админ не пополнит сток).
export function rollTier(pool: GachaTier[], pityCount: number): { tier: GachaTier; forced: boolean } {
  const alive = pool.filter(t => t.enabled && (t.prize_type !== 'item' || t.item_stock === null || t.item_stock > 0));
  const jackpot = alive.filter(t => t.rarity === 'jackpot');
  const rares = alive.filter(t => t.rarity === 'rare');
  const commons = alive.filter(t => t.rarity === 'common');
  if (commons.length === 0) throw new Error('Пул гачи пуст');

  const jackpotPpm = jackpot.reduce((s, t) => s + t.chance_ppm, 0);
  const r = randomInt(PPM_TOTAL);
  if (jackpot.length > 0 && r < jackpotPpm) return { tier: weightedPick(jackpot), forced: false };

  if (rares.length > 0 && pityCount >= HARD_PITY_AT - 1) {
    return { tier: weightedPick(rares), forced: true };
  }
  const rareBase = rares.reduce((s, t) => s + t.chance_ppm, 0);
  const softBonus = pityCount >= SOFT_PITY_FROM - 1 ? (pityCount - (SOFT_PITY_FROM - 2)) * SOFT_PITY_STEP_PPM : 0;
  const rarePpm = Math.min(PPM_TOTAL - jackpotPpm, rareBase + softBonus);
  if (rares.length > 0 && r < jackpotPpm + rarePpm) return { tier: weightedPick(rares), forced: false };

  return { tier: weightedPick(commons), forced: false };
}

export interface SpinResult {
  spinId: number;
  tierKey: string; name: string; icon: string; rarity: string;
  prizeType: 'eball' | 'item';
  eballAmount: number | null;
  inventoryItemId: number | null;
  forcedByPity: boolean;
  pityAfter: number;
  balanceAfter: number;
}

// Крутка целиком в одной транзакции: advisory-замок на юзера (двойной клик /
// гонки), лимиты, списание FIFO, ролл, приз (ебаллы в леджер / предмет в
// инвентарь через СУЩЕСТВУЮЩИЕ механизмы), лог крутки.
// pinEventId — успешная проверка пина, сделанная роутом ДО вызова (если была
// нужна по порогу/потолку на момент пре-чека цены, задача #2995). Здесь —
// защитный повторный чек: если стоимость крутки успела измениться настройками
// админа между пре-чеком и этой транзакцией и это МЕНЯЕТ требование пина —
// откатываем, а не молча пропускаем списание без пина.
export async function runSpin(db: Pool, bitrixId: number, pinEventId: number | null = null): Promise<SpinResult | { error: string }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('gacha_' || $1::text))`, [bitrixId]);

    const settings = await getGachaSettings(client);
    if (!settings.enabled) { await client.query('ROLLBACK'); return { error: 'Гача выключена' }; }
    if (!pinEventId) {
      const recheck = await spendPinRequirement(client, bitrixId, settings.spinCost);
      if (recheck.required) { await client.query('ROLLBACK'); return { error: 'Стоимость крутки изменилась — повторите ещё раз' }; }
    }

    const counts = await getSpinCounts(client, bitrixId);
    if (counts.today >= settings.dailyLimit) {
      await client.query('ROLLBACK');
      return { error: `Лимит круток на сегодня исчерпан (${settings.dailyLimit}/день) — возвращайтесь завтра` };
    }
    if (counts.week >= settings.weeklyLimit) {
      await client.query('ROLLBACK');
      return { error: `Лимит круток на неделю исчерпан (${settings.weeklyLimit}/нед)` };
    }

    const bal = await client.query<{ balance: string }>(
      `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger WHERE bitrix_id = $1 AND currency = 'EBALL'`,
      [bitrixId],
    );
    const balance = Number(bal.rows[0]?.balance ?? 0);
    if (balance < settings.spinCost) {
      await client.query('ROLLBACK');
      return { error: `Не хватает средств: крутка стоит ${settings.spinCost}, на балансе ${balance}` };
    }

    const pool = await getGachaPool(client);
    const pity = await getPityCount(client, bitrixId);
    const { tier, forced } = rollTier(pool, pity);

    // Списание крутки (FIFO — как любая трата EBALL).
    const spend = await client.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, comment, pin_event_id)
       VALUES ($1, $2, $3, 'EBALL', 'gacha_spin', $4, $5) RETURNING id`,
      [bitrixId, -settings.spinCost, settings.spinCost, `Крутка гачи`, pinEventId],
    );

    let prizeLedgerId: number | null = null;
    let inventoryItemId: number | null = null;
    if (tier.prize_type === 'eball') {
      const p = await client.query<{ id: number }>(
        `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, comment)
         VALUES ($1, $2, $2, 'EBALL', 'gacha_prize', $3) RETURNING id`,
        [bitrixId, tier.eball_amount, `Выигрыш в гаче: ${tier.name}`],
      );
      prizeLedgerId = p.rows[0].id;
    } else {
      // Предмет — в обычный инвентарь. Сток декрементируется (последний iPhone
      // не может уйти дважды: UPDATE под замком строки не пройдёт при 0).
      if (tier.item_stock !== null) {
        const st = await client.query(
          `UPDATE shop_items SET stock = stock - 1, updated_at = now() WHERE id = $1 AND stock > 0`,
          [tier.shop_item_id],
        );
        if (st.rowCount === 0) { await client.query('ROLLBACK'); return { error: 'Приз закончился — попробуйте ещё раз' }; }
      }
      // price_paid=1: предмет получен за крутку, 50%-возврат при истечении не
      // должен печатать ебаллы каталожной цены. Джекпот — сразу заявкой
      // руководителю (подтверждение выдачи), остальное — owned.
      const isJackpot = tier.rarity === 'jackpot';
      const inv = await client.query<{ id: number }>(
        `INSERT INTO inventory_items (bitrix_id, shop_item_id, item_name, price_paid, currency, status,
                                      expires_at, requested_at, activation_comment)
         VALUES ($1, $2, $3, 1, 'EBALL', $4, now() + make_interval(months => $5),
                 CASE WHEN $4 = 'activation_requested' THEN now() END,
                 CASE WHEN $4 = 'activation_requested' THEN 'Джекпот гачи 🎰 — подтвердите выдачу' END)
         RETURNING id`,
        [bitrixId, tier.shop_item_id, tier.item_name ?? tier.name,
         isJackpot ? 'activation_requested' : 'owned', tier.item_ttl_months ?? 3],
      );
      inventoryItemId = inv.rows[0].id;
    }
    await recomputeFifoRemaining(client, bitrixId);

    const spin = await client.query<{ id: number }>(
      `INSERT INTO gacha_spins (bitrix_id, tier_key, rarity, prize_name, eball_amount,
                                inventory_item_id, spend_ledger_id, prize_ledger_id, pity_count, forced_by_pity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [bitrixId, tier.tier_key, tier.rarity, tier.name, tier.eball_amount,
       inventoryItemId, spend.rows[0].id, prizeLedgerId, pity, forced],
    );
    // Редкий/джекпот — уведомление в ЛК (пуш «Аналитиком» шлёт роут после ответа).
    if (tier.rarity !== 'common') {
      await createNotification(client, {
        bitrixId,
        type: tier.rarity === 'jackpot' ? 'gacha_jackpot' : 'gacha_rare',
        title: tier.rarity === 'jackpot' ? `ДЖЕКПОТ в гаче: ${tier.name}!` : `Редкий приз в гаче: ${tier.name}`,
        body: tier.rarity === 'jackpot'
          ? 'Приз в инвентаре, заявка на выдачу уже у руководителя.'
          : 'Приз упал в ваш инвентарь.',
        link: '/profile',
      });
    }
    // Название валюты — ДО коммита (client после client.release() в finally
    // повторно использовать нельзя, гонка с чужим запросом из пула).
    const currencyName = tier.rarity === 'common' ? await getCurrencyName(client) : null;
    await client.query('COMMIT');
    if (tier.rarity !== 'common') {
      void pushViaAnalitik(bitrixId,
        tier.rarity === 'jackpot' ? `ДЖЕКПОТ в гаче: ${tier.name}!` : `Редкий приз в гаче: ${tier.name}`);
    } else {
      // Обычный приз (задача 2759, п.5): тише редкого/джекпота, без «!» и без
      // in-app уведомления (createNotification выше не пишется для common —
      // не трогаем это поведение), только короткий пуш ботом.
      void pushViaAnalitik(bitrixId, `🎰 Гача: ${tier.name}`,
        tier.prize_type === 'eball' ? `+${tier.eball_amount} ${currencyName}` : 'Приз упал в ваш инвентарь.');
    }

    const gained = tier.prize_type === 'eball' ? (tier.eball_amount ?? 0) : 0;
    return {
      spinId: spin.rows[0].id,
      tierKey: tier.tier_key, name: tier.name, icon: tier.icon, rarity: tier.rarity,
      prizeType: tier.prize_type, eballAmount: tier.eball_amount,
      inventoryItemId, forcedByPity: forced,
      pityAfter: tier.rarity === 'common' ? pity + 1 : 0,
      balanceAfter: balance - settings.spinCost + gained,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
