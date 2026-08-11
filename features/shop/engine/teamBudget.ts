// Командный бюджет отдела и цена командных товаров (задача 10.08.2026,
// миграция 171; обоснование — SHOP_CATALOG_DRAFT §6).
//
// ДВЕ СВЯЗАННЫЕ ВЕЩИ, КОТОРЫЕ НЕЛЬЗЯ РАЗДЕЛЯТЬ.
//
// 1. Цена командного товара сублинейно растёт от размера отдела:
//    `база × (1 + 0,5 × (n − 1))`. Линейная цена убила бы механику с двух
//    сторон: директор с 60 подчинёнными не купил бы никогда, РОП тройки покупал
//    бы ежедневно.
//
// 2. Платит НЕ личный кошелёк руководителя, а бюджет отдела, который
//    наполняется долей от начислений участников. Без этого никакая формула не
//    спасает: руководитель зарабатывает как один человек, а тратит на всех.
//    Бюджет нельзя вывести в рубли и нельзя перевести человеку — он тратится
//    только на командные позиции, иначе это была бы прибавка к зарплате РОПа.

import type { Pool, PoolClient } from 'pg';

/** Коэффициент цены от размера отдела. n <= 1 — множитель 1. */
export function teamPriceMultiplier(deptSize: number): number {
  const n = Math.max(1, Math.floor(deptSize));
  return 1 + 0.5 * (n - 1);
}

/** Цена командного товара для конкретного отдела (целые MLT). */
export function teamPrice(basePrice: number, deptSize: number): number {
  return Math.max(1, Math.round(basePrice * teamPriceMultiplier(deptSize)));
}

export async function fetchTeamBudget(db: Pool | PoolClient, deptKey: string | null): Promise<number> {
  if (!deptKey) return 0;
  try {
    const r = await db.query<{ b: string }>(
      `SELECT coalesce(balance, 0)::text AS b FROM team_budgets WHERE dept_key = $1`, [deptKey],
    );
    return Number(r.rows[0]?.b ?? 0);
  } catch { return 0; }   // до миграции 171 таблицы нет
}

/** Доля личных начислений, капающая в бюджет отдела. */
export async function fetchBudgetShare(db: Pool | PoolClient): Promise<number> {
  try {
    const r = await db.query<{ s: string }>(`SELECT team_budget_share::text AS s FROM badge_coin_settings WHERE id = 1`);
    const v = Number(r.rows[0]?.s ?? 0.05);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.05;
  } catch { return 0; }
}

/** Списать из бюджета отдела. В транзакции вызывающего.
 *  Возвращает false, если не хватило — гонки не будет: строка бюджета берётся
 *  FOR UPDATE, а CHECK (balance >= 0) не даст уйти в минус даже при ошибке в
 *  коде выше. */
export async function spendTeamBudget(
  client: PoolClient, deptKey: string, amount: number,
  opts: { bitrixId: number; shopItemId: number; comment: string },
): Promise<boolean> {
  await client.query(
    `INSERT INTO team_budgets (dept_key, balance) VALUES ($1, 0) ON CONFLICT (dept_key) DO NOTHING`, [deptKey],
  );
  const cur = await client.query<{ b: string }>(
    `SELECT balance::text AS b FROM team_budgets WHERE dept_key = $1 FOR UPDATE`, [deptKey],
  );
  if (Number(cur.rows[0]?.b ?? 0) < amount) return false;
  await client.query(
    `UPDATE team_budgets SET balance = balance - $2, updated_at = now() WHERE dept_key = $1`,
    [deptKey, amount],
  );
  await client.query(
    `INSERT INTO team_budget_ledger (dept_key, amount, source, bitrix_id, shop_item_id, comment)
     VALUES ($1, $2, 'purchase', $3, $4, $5)`,
    [deptKey, -amount, opts.bitrixId, opts.shopItemId, opts.comment],
  );
  return true;
}

/** Начислить в бюджеты отделов долю от НОВЫХ личных начислений MLT.
 *
 *  Зовётся из ночного пересчёта наград после accrueCoins, в той же транзакции.
 *  Идемпотентность — на уникальном индексе по `coin_ledger_id`: пересчёт
 *  наград полный, и без этого доля начислялась бы заново каждую ночь.
 *
 *  Отдел берётся из оргструктуры на момент прогона: заработал человек в отделе,
 *  где числится сейчас. Историю переводов не восстанавливаем — доля мелкая, а
 *  разбор «в каком отделе он был в марте» стоил бы дороже самой механики. */
export async function accrueTeamBudgetShare(
  client: PoolClient, deptOf: Map<number, string>,
): Promise<{ rows: number; total: number }> {
  const share = await fetchBudgetShare(client);
  if (share <= 0 || deptOf.size === 0) return { rows: 0, total: 0 };

  // Только начисления (amount > 0) в MLT, у которых доли ещё нет.
  const fresh = await client.query<{ id: string; bitrix_id: string; amount: string }>(
    `SELECT l.id, l.bitrix_id, l.amount
       FROM badge_coin_ledger l
       LEFT JOIN team_budget_ledger t ON t.coin_ledger_id = l.id AND t.source = 'share'
      WHERE l.amount > 0 AND l.currency = 'EBALL' AND t.id IS NULL
        AND l.source IN ('auto', 'quest')`,
  );
  let rows = 0, total = 0;
  for (const r of fresh.rows) {
    const dept = deptOf.get(Number(r.bitrix_id));
    if (!dept) continue;
    const amount = Math.round(Number(r.amount) * share * 100) / 100;
    if (amount <= 0) continue;
    await client.query(
      `INSERT INTO team_budgets (dept_key, balance) VALUES ($1, 0) ON CONFLICT (dept_key) DO NOTHING`, [dept],
    );
    const ins = await client.query(
      `INSERT INTO team_budget_ledger (dept_key, amount, source, bitrix_id, coin_ledger_id, comment)
       VALUES ($1, $2, 'share', $3, $4, $5)
       ON CONFLICT (coin_ledger_id) WHERE source = 'share' DO NOTHING`,
      [dept, amount, Number(r.bitrix_id), Number(r.id), `Доля отдела ${Math.round(share * 100)}% от начисления`],
    );
    if ((ins.rowCount ?? 0) === 0) continue;   // уже начислено другим прогоном
    await client.query(
      `UPDATE team_budgets SET balance = balance + $2, updated_at = now() WHERE dept_key = $1`,
      [dept, amount],
    );
    rows++; total += amount;
  }
  return { rows, total: Math.round(total * 100) / 100 };
}
