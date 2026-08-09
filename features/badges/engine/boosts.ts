// Движок бустов (задача 51, миграция 167).
//
// Буст множит ТОЛЬКО XP. MLT он не трогает нигде и никогда — это ядро балансной
// логики (SHOP_CATALOG_DRAFT §5-бис): множитель на MLT печатает валюту, а буст
// обязан её вымывать. Если однажды захочется «ну чуть-чуть и на баллы» — не
// надо, вся экономика бустов держится ровно на этом запрете.
//
// ГЛАВНАЯ ТЕХНИЧЕСКАЯ ЗАДАЧА — идемпотентность. `xp_ledger` пересчитывается
// целиком каждым тиком (DELETE + INSERT). Наивное «применить активные бусты к
// подходящим сделкам» означало бы, что вчерашняя сделка завтра пересчитается
// уже без буста (заряды кончились, окно закрылось) и XP человека молча уедет
// вниз. Поэтому расход фиксируется строкой в `boost_consumptions` с УЖЕ
// ПОСЧИТАННОЙ прибавкой — тот же приём, что `price_at_award` у наград.
//
// Порядок в тике: сначала читаем, что уже потрачено (это неизменяемо), потом
// тратим оставшиеся заряды на новые события в хронологическом порядке.

import type { Pool, PoolClient } from 'pg';

export type BoostAxis = 'repeat' | 'primary' | 'crosssell' | 'big_deal' | 'speed' | 'shipments' | 'all_sales';
export type BoostKind = 'personal' | 'team';

export const BOOST_AXIS_LABELS: Record<BoostAxis, string> = {
  repeat: 'Повторные продажи',
  primary: 'Первичные продажи',
  crosssell: 'Допродажи по рекомендации',
  big_deal: 'Крупные сделки (от 1 млн)',
  speed: 'Сделки быстрее медианы группы',
  shipments: 'Отгрузки',
  all_sales: 'Все продажи',
};

/** Порог «крупной сделки» — тот же 1 млн, что у награды «Крупная рыба». */
const BIG_DEAL_RUB = 1_000_000;

export interface ActiveBoost {
  id: number; bitrixId: number; deptKey: string | null; kind: BoostKind;
  axis: BoostAxis; multiplier: number;
  chargesTotal: number | null; chargesLeft: number | null;
  /** Границы окна — ДНИ МСК, не моменты. Причина: XP-движок знает о сделке
   *  только день продажи/отгрузки (`sold_day`/`ship_day`), точного времени в
   *  его выборке нет. Сравнивать день события с точным timestamp активации
   *  значило бы врать в обе стороны. Поэтому окно тоже дневное: буст,
   *  активированный сегодня, работает с сегодняшнего дня по день истечения
   *  включительно. Чуть щедрее к человеку и, главное, предсказуемо. */
  activatedDay: string; expiresDay: string;
  expiresAt: string;   // точный момент — только для показа в ЛК
}

/** Признаки сделки, по которым решается, попадает ли она под ось буста.
 *  Считает их XP-движок — здесь только правило соответствия, чтобы «что такое
 *  допродажа» не разошлось с тем, как её считает начисление XP. */
export interface BoostDealFacts {
  dealId: number; bitrixId: number;
  soldDay: string | null;     // YYYY-MM-DD МСК — по нему окно и порядок
  shipDay: string | null;
  amount: number;
  isRepeat: boolean;
  crossSold: boolean;
  fasterThanMedian: boolean;
  baseXp: number;             // XP сделки БЕЗ буста
}

export function matchesAxis(axis: BoostAxis, d: BoostDealFacts): boolean {
  switch (axis) {
    case 'repeat': return d.soldDay !== null && d.isRepeat;
    case 'primary': return d.soldDay !== null && !d.isRepeat;
    case 'crosssell': return d.soldDay !== null && d.crossSold;
    case 'big_deal': return d.soldDay !== null && d.amount >= BIG_DEAL_RUB;
    case 'speed': return d.soldDay !== null && d.fasterThanMedian;
    case 'shipments': return d.shipDay !== null;
    case 'all_sales': return d.soldDay !== null;
  }
}

/** Момент, по которому событие попадает (или нет) в окно буста. */
function eventAt(axis: BoostAxis, d: BoostDealFacts): string | null {
  return axis === 'shipments' ? d.shipDay : d.soldDay;
}

export async function loadActiveBoosts(db: Pool | PoolClient): Promise<ActiveBoost[]> {
  try {
    const r = await db.query<{
      id: string; bitrix_id: string; dept_key: string | null; kind: BoostKind;
      axis: BoostAxis; multiplier: string; charges_total: number | null; charges_left: number | null;
      activated_day: string; expires_day: string; expires_at: string;
    }>(
      `SELECT id, bitrix_id, dept_key, kind, axis, multiplier, charges_total, charges_left,
              (activated_at AT TIME ZONE 'Europe/Moscow')::date::text AS activated_day,
              (expires_at   AT TIME ZONE 'Europe/Moscow')::date::text AS expires_day,
              expires_at
         FROM active_boosts WHERE status = 'active' ORDER BY activated_at`,
    );
    return r.rows.map(x => ({
      id: Number(x.id), bitrixId: Number(x.bitrix_id), deptKey: x.dept_key, kind: x.kind,
      axis: x.axis, multiplier: Number(x.multiplier),
      chargesTotal: x.charges_total, chargesLeft: x.charges_left,
      activatedDay: x.activated_day, expiresDay: x.expires_day,
      expiresAt: new Date(x.expires_at).toISOString(),
    }));
  } catch { return []; }   // до миграции 167 таблицы нет — бустов просто нет
}

export interface BoostApplication {
  /** dealId → сколько XP добавил буст (уже зафиксировано или назначено сейчас). */
  byDeal: Map<number, number>;
  /** Новые расходы, которые надо записать в БД после пересчёта. */
  fresh: { boostId: number; dealId: number; bitrixId: number; baseXp: number; boostXp: number }[];
  /** Бусты, у которых кончились заряды или вышел срок. */
  finished: { id: number; status: 'spent' | 'expired' }[];
  /** Остаток зарядов после прогона — для UPDATE. */
  chargesLeft: Map<number, number>;
}

/** Разложить активные бусты по сделкам тика.
 *
 *  `deptOf` — принадлежность менеджера отделу на момент прогона (командный буст
 *  действует на текущий состав отдела; историю состава не восстанавливаем —
 *  окно у командного буста сутки, за сутки состав не меняется).
 *
 *  Один буст на сделку: если у человека активны два подходящих, применяется
 *  БОЛЕЕ СИЛЬНЫЙ. Стакать нельзя — иначе покупкой трёх бустов на одну ось
 *  делается ×8, и любая калибровка теряет смысл. */
export function applyBoosts(
  boosts: ActiveBoost[], deals: BoostDealFacts[],
  already: Map<string, { boostId: number; boostXp: number }>,   // ключ `${boostId}:${dealId}`
  deptOf: Map<number, string>, nowIso: string,
): BoostApplication {
  const byDeal = new Map<number, number>();
  const fresh: BoostApplication['fresh'] = [];
  const chargesLeft = new Map<number, number>();
  const finished: BoostApplication['finished'] = [];

  for (const b of boosts) if (b.chargesLeft !== null) chargesLeft.set(b.id, b.chargesLeft);

  // Уже потраченное — неизменяемо, кладём первым и больше не трогаем.
  const consumedDeals = new Set<number>();
  for (const [key, v] of already) {
    const dealId = Number(key.slice(key.indexOf(':') + 1));
    byDeal.set(dealId, (byDeal.get(dealId) ?? 0) + v.boostXp);
    consumedDeals.add(dealId);
  }

  // Хронологический порядок — заряды обязаны тратиться на РАННИЕ события, иначе
  // при двух прогонах подряд один и тот же заряд достался бы разным сделкам.
  const sorted = [...deals].sort((a, b) => {
    const x = a.soldDay ?? a.shipDay ?? '';
    const y = b.soldDay ?? b.shipDay ?? '';
    return x < y ? -1 : x > y ? 1 : a.dealId - b.dealId;
  });

  for (const d of sorted) {
    if (consumedDeals.has(d.dealId)) continue;    // уже под бустом
    if (d.baseXp <= 0) continue;
    // Кандидаты: личные буста владельца сделки + командные его отдела.
    const dept = deptOf.get(d.bitrixId);
    const candidates = boosts.filter(b => {
      if (b.kind === 'personal' && b.bitrixId !== d.bitrixId) return false;
      if (b.kind === 'team' && (dept === undefined || b.deptKey !== dept)) return false;
      if (!matchesAxis(b.axis, d)) return false;
      const at = eventAt(b.axis, d);
      if (at === null || at < b.activatedDay || at > b.expiresDay) return false;
      if (b.kind === 'personal' && (chargesLeft.get(b.id) ?? 0) <= 0) return false;
      return true;
    });
    if (candidates.length === 0) continue;
    // Более сильный выигрывает; при равенстве — активированный раньше
    // (иначе покупка второго такого же буста «замораживала» бы первый).
    candidates.sort((a, b) => b.multiplier - a.multiplier || (a.activatedDay < b.activatedDay ? -1 : 1));
    const b = candidates[0];
    const boostXp = Math.round(d.baseXp * (b.multiplier - 1));
    if (boostXp <= 0) continue;
    byDeal.set(d.dealId, (byDeal.get(d.dealId) ?? 0) + boostXp);
    fresh.push({ boostId: b.id, dealId: d.dealId, bitrixId: d.bitrixId, baseXp: d.baseXp, boostXp });
    if (b.kind === 'personal') chargesLeft.set(b.id, (chargesLeft.get(b.id) ?? 0) - 1);
  }

  for (const b of boosts) {
    if (b.kind === 'personal' && (chargesLeft.get(b.id) ?? 0) <= 0) finished.push({ id: b.id, status: 'spent' });
    else if (b.expiresAt < nowIso) finished.push({ id: b.id, status: 'expired' });
  }
  return { byDeal, fresh, finished, chargesLeft };
}

/** Уже зафиксированные расходы — читаются ДО пересчёта. */
export async function loadConsumptions(db: Pool | PoolClient): Promise<Map<string, { boostId: number; boostXp: number }>> {
  const out = new Map<string, { boostId: number; boostXp: number }>();
  try {
    const r = await db.query<{ boost_id: string; deal_id: string; boost_xp: number }>(
      `SELECT boost_id, deal_id, boost_xp FROM boost_consumptions`,
    );
    for (const x of r.rows) {
      out.set(`${x.boost_id}:${x.deal_id}`, { boostId: Number(x.boost_id), boostXp: Number(x.boost_xp) });
    }
  } catch { /* до миграции 167 таблицы нет */ }
  return out;
}

/** Записать новые расходы и обновить состояние бустов. В транзакции вызывающего. */
export async function persistBoostUsage(db: PoolClient, app: BoostApplication): Promise<void> {
  for (const f of app.fresh) {
    await db.query(
      `INSERT INTO boost_consumptions (boost_id, deal_id, bitrix_id, base_xp, boost_xp)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (boost_id, deal_id) DO NOTHING`,
      [f.boostId, f.dealId, f.bitrixId, f.baseXp, f.boostXp],
    );
  }
  for (const [id, left] of app.chargesLeft) {
    await db.query(`UPDATE active_boosts SET charges_left = $2 WHERE id = $1`, [id, Math.max(0, left)]);
  }
  for (const f of app.finished) {
    await db.query(`UPDATE active_boosts SET status = $2 WHERE id = $1 AND status = 'active'`, [f.id, f.status]);
  }
}

// ── активация буста из инвентаря ─────────────────────────────────────────────

export type ActivateResult =
  | { ok: true; boostId: number; expiresAt: string }
  | { ok: false; error: string };

/** Активировать купленный буст (предмет инвентаря со статусом `owned`).
 *
 *  Личный — заряды из `shop_items.boost_charges`, срок годности
 *  `boost_window_days` (по умолчанию 7 дней «на израсходовать»).
 *  Командный — окно `boost_window_days` в СУТКАХ на текущий отдел покупателя. */
export async function activateBoost(
  db: Pool, mgr: number, inventoryItemId: number, deptKey: string | null,
): Promise<ActivateResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query<{ id: string; shop_item_id: number; status: string }>(
      `SELECT id, shop_item_id, status FROM inventory_items
        WHERE id = $1 AND bitrix_id = $2 FOR UPDATE`,
      [inventoryItemId, mgr],
    );
    if (inv.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Предмет не найден' }; }
    if (inv.rows[0].status !== 'owned') { await client.query('ROLLBACK'); return { ok: false, error: 'Предмет уже использован' }; }

    const item = await client.query<{
      boost_metric: string | null; boost_multiplier: string | null;
      boost_window_days: number | null; boost_scope: string | null; boost_charges: number | null;
    }>(
      `SELECT boost_metric, boost_multiplier, boost_window_days, boost_scope, boost_charges
         FROM shop_items WHERE id = $1`,
      [inv.rows[0].shop_item_id],
    );
    const it = item.rows[0];
    const axis = (it?.boost_metric ?? '') as BoostAxis;
    const mult = Number(it?.boost_multiplier ?? 0);
    if (!it || !(axis in BOOST_AXIS_LABELS) || !(mult > 1)) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Это не буст — у товара не заданы ось и множитель' };
    }
    const kind: BoostKind = it.boost_scope === 'team' ? 'team' : 'personal';
    if (kind === 'team' && !deptKey) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Командный буст нельзя активировать без отдела' };
    }
    const days = it.boost_window_days ?? (kind === 'team' ? 1 : 7);
    const charges = kind === 'personal' ? (it.boost_charges ?? 3) : null;

    const already = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM active_boosts
        WHERE status='active' AND kind=$2 AND axis=$3
          AND ($2 = 'team' AND dept_key = $4 OR $2 = 'personal' AND bitrix_id = $1)`,
      [mgr, kind, axis, deptKey],
    );
    if (Number(already.rows[0].c) > 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Такой буст уже активен — дождитесь, пока он закончится' };
    }

    const res = await client.query<{ id: string; expires_at: string }>(
      `INSERT INTO active_boosts (bitrix_id, dept_key, kind, axis, multiplier, charges_total,
         charges_left, expires_at, shop_item_id, inventory_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$6, now() + make_interval(days => $7), $8, $9)
       RETURNING id, expires_at`,
      [mgr, kind === 'team' ? deptKey : null, kind, axis, mult, charges, days,
        inv.rows[0].shop_item_id, inventoryItemId],
    );
    // В inventory_items нет отдельной колонки «когда использовали» — статус
    // 'used' + resolved_at, как у остального пути активации предметов.
    await client.query(
      `UPDATE inventory_items SET status = 'used', resolved_at = now(),
         resolve_comment = coalesce(resolve_comment, 'Буст активирован')
       WHERE id = $1`, [inventoryItemId]);
    await client.query('COMMIT');
    return { ok: true, boostId: Number(res.rows[0].id), expiresAt: new Date(res.rows[0].expires_at).toISOString() };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Активные бусты человека (и его отдела) — для показа в ЛК. */
export async function fetchMyBoosts(
  db: Pool, mgr: number, deptKey: string | null,
): Promise<{ id: number; kind: BoostKind; axis: BoostAxis; axisLabel: string; multiplier: number;
  chargesLeft: number | null; chargesTotal: number | null; expiresAt: string }[]> {
  try {
    const r = await db.query<{
      id: string; kind: BoostKind; axis: BoostAxis; multiplier: string;
      charges_left: number | null; charges_total: number | null; expires_at: string;
    }>(
      `SELECT id, kind, axis, multiplier, charges_left, charges_total, expires_at
         FROM active_boosts
        WHERE status='active' AND expires_at > now()
          AND (bitrix_id = $1 OR (kind='team' AND dept_key IS NOT DISTINCT FROM $2))
        ORDER BY expires_at`,
      [mgr, deptKey],
    );
    return r.rows.map(x => ({
      id: Number(x.id), kind: x.kind, axis: x.axis, axisLabel: BOOST_AXIS_LABELS[x.axis] ?? x.axis,
      multiplier: Number(x.multiplier), chargesLeft: x.charges_left, chargesTotal: x.charges_total,
      expiresAt: new Date(x.expires_at).toISOString(),
    }));
  } catch { return []; }
}
