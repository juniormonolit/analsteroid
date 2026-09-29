// Загрузка данных sd для раздела «Реализация» (только SELECT). Выборка периода
// кэшируется на 5 минут: основной запрос по когорте ~3 тыс. заявок идёт ~5–7 с.
import { sdDb } from '../db/clients';
import { cached } from '../cache/redis';
import {
  SQL_PERIOD_REQUESTS, SQL_STATUS_INTERVALS, SQL_OVERDUE, SQL_ORPHAN_PURCHASES, SQL_LOGISTS,
  SQL_CARD_HEAD, SQL_CARD_LINES, SQL_CARD_PURCHASES, SQL_CARD_HISTORY,
} from './sql';
import { toReqRow, type ReqRow, type OverdueRow, type StatusInterval } from './metrics';

const TTL = 300;

export async function loadPeriodRows(from: string, to: string): Promise<ReqRow[]> {
  return cached(`realizations:rows:v1:${from}:${to}`, TTL, async () => {
    const { rows } = await sdDb().query(SQL_PERIOD_REQUESTS, [from, to]);
    return rows.map(toReqRow);
  });
}

export async function loadStatusIntervals(from: string, to: string): Promise<StatusInterval[]> {
  return cached(`realizations:intervals:v1:${from}:${to}`, TTL, async () => {
    const { rows } = await sdDb().query(SQL_STATUS_INTERVALS, [from, to]);
    return rows.map(r => ({ logist_id: r.logist_id ?? null, status: String(r.status), hours: Number(r.hours) }));
  });
}

export async function loadOverdue(): Promise<OverdueRow[]> {
  return cached('realizations:overdue:v1', TTL, async () => {
    const { rows } = await sdDb().query(SQL_OVERDUE);
    return rows.map(r => ({ logist_id: r.logist_id ?? null, shipment_date: String(r.shipment_date) }));
  });
}

export interface OrphanPurchaseRow { creator: string; n: number; amountVat: number; nAccountable: number }
export async function loadOrphanPurchases(from: string, to: string): Promise<OrphanPurchaseRow[]> {
  return cached(`realizations:orphans:v1:${from}:${to}`, TTL, async () => {
    const { rows } = await sdDb().query(SQL_ORPHAN_PURCHASES, [from, to]);
    return rows.map(r => ({ creator: String(r.creator), n: Number(r.n), amountVat: Number(r.amount_vat ?? 0), nAccountable: Number(r.n_accountable) }));
  });
}

export async function loadLogists(from: string): Promise<{ id: string; name: string }[]> {
  return cached(`realizations:logists:v1:${from}`, TTL, async () => {
    const { rows } = await sdDb().query(SQL_LOGISTS, [from]);
    return rows.map(r => ({ id: String(r.id), name: String(r.name) }));
  });
}

export async function loadRequestCard(id: string) {
  const db = sdDb();
  const head = await db.query(SQL_CARD_HEAD, [id]);
  if (!head.rows.length) return null;
  const [lines, purchases, history] = await Promise.all([
    db.query(SQL_CARD_LINES, [id]), db.query(SQL_CARD_PURCHASES, [id]), db.query(SQL_CARD_HISTORY, [id]),
  ]);
  return { head: head.rows[0], lines: lines.rows, purchases: purchases.rows, history: history.rows };
}
