// FIFO-кошелёк ебаллов + TTL (задача 31.07): remaining на положительных
// EBALL-записях леджера («лотах») — вычислимая материализация, пересчитывается
// одним UPDATE с оконной функцией (см. комментарий в migrations/119_eball_ttl.sql).
// Сгорание начислений (source='expiry') и истечение предметов инвентаря с
// возвратом 50% (source='shop_refund') — ночной тик в runBadgeRecompute,
// той же транзакцией, что награды/валюта. Всё идемпотентно.

import type { Pool, PoolClient } from 'pg';

// Курс единицы индексации магазина: сейчас 1 единица = 1 ебалл. Задел под
// индексацию (owners-inbox/monolitika-eball-indexation.md): когда появится
// индекс, здесь будет расчётный курс (k × I_мед / I_топ) — цены каталога
// хранятся в единицах (shop_items.price_units) и поедут сами.
export const UNIT_EBALL_RATE = 1;

export function priceEball(priceUnits: number): number {
  return Math.round(priceUnits * UNIT_EBALL_RATE);
}

// Рублёвая цена: ебалльная по курсу конвертации (1 ₽ = rate ебаллов → ₽ = еб/rate).
export function priceRub(priceUnits: number, rubToEballRate: number): number {
  return Math.max(1, Math.round(priceEball(priceUnits) / rubToEballRate));
}

export interface WalletTickStats {
  expiredLedger: number;   // строк 'expiry' (сколько менеджеров задело сгорание)
  expiredAmount: number;   // сгоревших ебаллов суммой
  expiredItems: number;    // предметов инвентаря с истёкшим сроком
  refundedAmount: number;  // возвращено 50% ебаллов/рублей суммой (по модулю)
  // Кому в ЭТОМ тике завелась НОВАЯ строка expiry_soon (задача 2759, п.10) —
  // вызывающий (compute.ts) шлёт по ним пуш «Аналитиком» ПОСЛЕ коммита;
  // недельный дедуп уже применён на уровне INSERT (NOT EXISTS ниже).
  expirySoonPushes: { bitrixId: number; amount: number; days: number }[];
}

// Пересчёт remaining: remaining = clamp(cum − D, 0, amount) по FIFO
// (created_at, id) на пользователя. Идемпотентно; bitrixId — точечно после
// покупки, без аргумента — весь леджер (ночной тик, ~7 тыс. строк — мгновенно).
export async function recomputeFifoRemaining(client: PoolClient, bitrixId?: number): Promise<void> {
  const filter = bitrixId !== undefined ? 'AND bitrix_id = $1' : '';
  const params = bitrixId !== undefined ? [bitrixId] : [];
  await client.query(
    `WITH deb AS (
       SELECT bitrix_id, coalesce(sum(-amount), 0)::bigint AS d
         FROM badge_coin_ledger WHERE currency = 'EBALL' AND amount < 0 ${filter} GROUP BY 1
     ),
     pos AS (
       SELECT id, bitrix_id, amount,
              sum(amount) OVER (PARTITION BY bitrix_id ORDER BY created_at, id) AS cum
         FROM badge_coin_ledger WHERE currency = 'EBALL' AND amount > 0 ${filter}
     )
     UPDATE badge_coin_ledger l
        SET remaining = greatest(0, least(l.amount, p.cum - coalesce(deb.d, 0)))::int
       FROM pos p
       LEFT JOIN deb ON deb.bitrix_id = p.bitrix_id
      WHERE l.id = p.id
        AND l.remaining IS DISTINCT FROM greatest(0, least(l.amount, p.cum - coalesce(deb.d, 0)))::int`,
    params,
  );
}

// Ночной тик кошелька: (1) истечение предметов инвентаря → status='expired' +
// возврат 50% цены в валюте покупки; (2) сгорание EBALL-лотов старше ttl_months.
// Порядок: сначала предметы (возврат создаёт новые лоты), затем пересчёт
// remaining, затем сгорание по свежим остаткам, затем финальный пересчёт.
export async function runWalletTick(client: PoolClient): Promise<WalletTickStats> {
  // 1. Истечение предметов: только не активированные (owned). Предмет в статусе
  // activation_requested не сгорает — решение по заявке важнее дедлайна.
  const items = await client.query<{ id: number; bitrix_id: number; refund: number; currency: string; item_name: string }>(
    `UPDATE inventory_items
        SET status = 'expired', resolved_at = now()
      WHERE status = 'owned' AND expires_at < now()
      RETURNING id, bitrix_id, floor(price_paid / 2.0)::int AS refund, currency, item_name`,
  );
  let refundedAmount = 0;
  for (const it of items.rows) {
    if (it.refund <= 0) continue;
    refundedAmount += it.refund;
    const led = await client.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, comment, inventory_item_id)
       VALUES ($1, $2, $2, $3, 'shop_refund', $4, $5) RETURNING id`,
      [it.bitrix_id, it.refund, it.currency, `Срок предмета «${it.item_name}» истёк — возврат 50% цены`, it.id],
    );
    await client.query(`UPDATE inventory_items SET refund_ledger_id = $2 WHERE id = $1`, [it.id, led.rows[0].id]);
  }

  // 2. Сгорание EBALL-начислений старше ttl_months (RUB не трогаем по условию).
  await recomputeFifoRemaining(client);
  const exp = await client.query<{ amount: number }>(
    `WITH s AS (SELECT ttl_months, currency_name FROM badge_coin_settings WHERE id = 1),
     burn AS (
       SELECT l.bitrix_id, sum(l.remaining)::int AS amt
         FROM badge_coin_ledger l, s
        WHERE l.currency = 'EBALL' AND l.amount > 0 AND l.remaining > 0
          AND l.created_at < now() - make_interval(months => s.ttl_months)
        GROUP BY l.bitrix_id
     )
     INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, comment)
     SELECT b.bitrix_id, -b.amt, b.amt, 'EBALL', 'expiry',
            'Сгорание: начисления старше ' || s.ttl_months || ' мес (срок жизни ' || s.currency_name || ')'
       FROM burn b, s
      WHERE b.amt > 0
     RETURNING -amount AS amount`,
  );
  if ((exp.rowCount ?? 0) > 0 || items.rows.length > 0) await recomputeFifoRemaining(client);

  // Уведомление о скором сгорании (задача 2759: горизонт расширен 7→30 дней —
  // при TTL 6 мес неделя предупреждения слишком мало; недельный дедуп на
  // человека остался тем же — не чаще одного уведомления в 7 дней). RETURNING
  // отдаёт ТОЛЬКО реально вставленные (NOT EXISTS-дедуп применился) — их и
  // пушит вызывающий (compute.ts) ботом «Аналитик» ПОСЛЕ коммита.
  const soonIns = await client.query<{ bitrix_id: number; amt: number; days: number }>(
    `WITH s AS (SELECT ttl_months, currency_name FROM badge_coin_settings WHERE id = 1),
     soon AS (
       SELECT l.bitrix_id, sum(l.remaining)::int AS amt,
              greatest(0, ceil(extract(epoch FROM min(l.created_at + make_interval(months => s.ttl_months)) - now()) / 86400))::int AS days
         FROM badge_coin_ledger l, s
        WHERE l.currency = 'EBALL' AND l.amount > 0 AND l.remaining > 0
          AND l.created_at + make_interval(months => s.ttl_months) < now() + interval '30 days'
        GROUP BY l.bitrix_id
     ),
     ins AS (
       INSERT INTO notifications (bitrix_id, type, title, body, link)
       SELECT w.bitrix_id, 'expiry_soon',
              'Скоро сгорит ' || w.amt || ' ' || s.currency_name,
              'Через ' || w.days || ' дн. истечёт срок жизни части начислений — потратьте их в магазине.',
              '/manager/me'
         FROM soon w, s
        WHERE w.amt > 0
          AND NOT EXISTS (SELECT 1 FROM notifications n
                           WHERE n.bitrix_id = w.bitrix_id AND n.type = 'expiry_soon'
                             AND n.created_at > now() - interval '7 days')
       RETURNING bitrix_id
     )
     SELECT ins.bitrix_id::int AS bitrix_id, soon.amt, soon.days
       FROM ins JOIN soon ON soon.bitrix_id = ins.bitrix_id`,
  );

  return {
    expiredLedger: exp.rowCount ?? 0,
    expiredAmount: exp.rows.reduce((s, r) => s + Number(r.amount), 0),
    expiredItems: items.rows.length,
    refundedAmount,
    expirySoonPushes: soonIns.rows.map(r => ({ bitrixId: r.bitrix_id, amount: r.amt, days: r.days })),
  };
}

// Плашка ЛК «сгорит N ебаллов через X дней»: живые остатки лотов, чей дедлайн
// (created_at + ttl) в ближайшие horizonDays (включая уже просроченные —
// сгорят ближайшим ночным тиком, days = 0).
export async function getExpiringSoon(
  db: Pool, bitrixId: number, horizonDays = 30,
): Promise<{ amount: number; days: number } | null> {
  const r = await db.query<{ amount: string; days: string }>(
    `WITH s AS (SELECT ttl_months FROM badge_coin_settings WHERE id = 1)
     SELECT coalesce(sum(l.remaining), 0) AS amount,
            greatest(0, ceil(extract(epoch FROM min(l.created_at + make_interval(months => s.ttl_months)) - now()) / 86400))::int AS days
       FROM badge_coin_ledger l, s
      WHERE l.bitrix_id = $1 AND l.currency = 'EBALL' AND l.amount > 0 AND l.remaining > 0
        AND l.created_at + make_interval(months => s.ttl_months) < now() + make_interval(days => $2)
      GROUP BY s.ttl_months`,
    [bitrixId, horizonDays],
  );
  if (r.rows.length === 0 || Number(r.rows[0].amount) <= 0) return null;
  return { amount: Number(r.rows[0].amount), days: Number(r.rows[0].days) };
}

// Та же плашка, но по ВСЕЙ компании (виджет «здоровье экономики» на дашборде
// геймификации, задача 2741) — сумма живых остатков лотов у всех менеджеров,
// чей дедлайн (created_at + ttl) попадает в ближайшие horizonDays.
export async function getExpiringSoonTotal(
  db: Pool, horizonDays = 30,
): Promise<number> {
  const r = await db.query<{ amount: string }>(
    `WITH s AS (SELECT ttl_months FROM badge_coin_settings WHERE id = 1)
     SELECT coalesce(sum(l.remaining), 0) AS amount
       FROM badge_coin_ledger l, s
      WHERE l.currency = 'EBALL' AND l.amount > 0 AND l.remaining > 0
        AND l.created_at + make_interval(months => s.ttl_months) < now() + make_interval(days => $1)`,
    [horizonDays],
  );
  return Number(r.rows[0]?.amount ?? 0);
}
