// Загрузка данных sd для раздела «Реализация» (только SELECT). Выборка периода
// кэшируется на 5 минут: основной запрос по когорте ~3 тыс. заявок идёт ~5–7 с.
import { sdDb } from '../db/clients';
import { cached } from '../cache/redis';
import {
  SQL_PERIOD_REQUESTS, SQL_STATUS_INTERVALS, SQL_OVERDUE, SQL_ORPHAN_PURCHASES, SQL_LOGISTS,
  SQL_CARD_HEAD, SQL_CARD_LINES, SQL_CARD_PURCHASES, SQL_CARD_HISTORY,
} from './sql';
import { toReqRow, type ReqRow, type OverdueRow, type StatusInterval } from './metrics';
import { SQL_CALL_AGG, SQL_CALL_LOGIST_MAP, SQL_CALL_LOGIST_MAP_FALLBACK, sqlCallList, toCallAgg, type CallAgg, type CallMapRow } from './callMetrics';

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

// ── Звонки логистов (задача #8314): va.calls_logist + мост disp.logist_bitrix_map ──

export async function loadCallLogistMap(): Promise<CallMapRow[]> {
  return cached('realizations:call-map:v1', TTL, async () => {
    let rows: Record<string, unknown>[];
    try {
      rows = (await sdDb().query(SQL_CALL_LOGIST_MAP)).rows;
    } catch (e) {
      // Чтение disp у роли приложения планируют снять — тогда мост из поля 1С.
      if (!/permission denied/i.test((e as Error).message ?? '')) throw e;
      console.warn('[realizations calls] disp.logist_bitrix_map недоступна, мост по sd.users_1c.bitrix_user_id');
      rows = (await sdDb().query(SQL_CALL_LOGIST_MAP_FALLBACK)).rows;
    }
    return rows.map(r => ({ logistId: String(r.logist_id), bitrixId: String(r.bitrix_id), name: String(r.name ?? ''), verified: !!r.verified, load: Number(r.load ?? 0) }));
  });
}

/** Агрегат звонков по ключам строк: uids[i] → keys[i]. Итог — общая строка (grouping set ()). */
export async function loadCallAgg(from: string, to: string, uids: string[], keys: string[]): Promise<{ byKey: Map<string, CallAgg>; total: CallAgg | null }> {
  const sig = uids.map((u, i) => `${u}=${keys[i]}`).sort().join(',');
  const rows = await cached(`realizations:calls:v1:${from}:${to}:${sig}`, 120, async () => (await sdDb().query(SQL_CALL_AGG, [from, to, uids, keys])).rows);
  const byKey = new Map<string, CallAgg>();
  let total: CallAgg | null = null;
  for (const r of rows) {
    if (r.is_total) total = toCallAgg(r);
    else byKey.set(String(r.k), toCallAgg(r));
  }
  return { byKey, total };
}

export interface CallListRow {
  id: string; started_at: string; direction: string; phone: string | null; duration_seconds: number | null;
  failed_code: string | null; failed_reason: string | null; transcription_status: string | null; bitrix_id: string;
}
export async function loadCallList(from: string, to: string, uids: string[], where: string): Promise<CallListRow[]> {
  const { rows } = await sdDb().query(sqlCallList(where), [from, to, uids]);
  return rows as CallListRow[];
}
