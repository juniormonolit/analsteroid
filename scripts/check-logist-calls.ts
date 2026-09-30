/**
 * Сверка группы «Звонки» (задачи #8314, #8357) на живой базе: SQL_CALL_AGG (то, что считает
 * отчёт, резолв звонка через va.logist_bitrix_map по started_at) против JS-эталона:
 * resolveCallLogist + aggregateCallsJs по сырым строкам va.calls_logist — по каждому логисту
 * и по «Итого». Только чтение. Окружение — как у приложения (SA_PG_*).
 *   NODE_OPTIONS=--experimental-strip-types node --env-file=.env.local \
 *     --import ./scripts/ts-resolve-register.mjs scripts/check-logist-calls.ts 2026-09-30 2026-10-31
 */
import { sdDb } from '../lib/db/clients.ts';
import { SQL_CALL_AGG, SQL_CALL_LOGIST_MAP, aggregateCallsJs, callLogists, resolveCallLogist, toCallAgg, toCallMapRow, type CallAgg } from '../lib/realizations/callMetrics.ts';

const [from = '2026-09-30', to = '2026-12-31'] = process.argv.slice(2);
const db = sdDb();
const c = await db.connect();
let bad = 0;
try {
  await c.query('SET default_transaction_read_only = on');
  const map = (await c.query(SQL_CALL_LOGIST_MAP)).rows.map(toCallMapRow);
  const logists = callLogists(map, from, to);
  const ids = [...logists.keys()];
  const agg = (await c.query(SQL_CALL_AGG, [from, to, ids, ids])).rows;
  const raw = (await c.query(`select portal_user_id::text uid, started_at, direction, duration_seconds, failed_code, transcription_status, phone from va.calls_logist
    where started_at >= ($1::date)::timestamp at time zone 'Europe/Moscow' and started_at < ($2::date + 1)::timestamp at time zone 'Europe/Moscow'`, [from, to])).rows;
  const byKey = new Map<string, typeof raw>();
  const resolved: typeof raw = [];
  let unresolved = 0;
  for (const r of raw) {
    const k = resolveCallLogist(map, r.uid, r.started_at);
    if (!k || !logists.has(k)) { unresolved++; continue; }
    resolved.push(r);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const cmp = (label: string, a: CallAgg, b: CallAgg) => {
    const diff = (Object.keys(a) as (keyof CallAgg)[]).filter(k => Math.abs(a[k] - b[k]) > 1e-9);
    if (diff.length) { bad++; console.log(`DIFF ${label}: ${diff.map(k => `${k} sql=${a[k]} js=${b[k]}`).join(', ')}`); }
    else console.log(`ok   ${label}: всего ${a.total}, исх ${a.nOut}, вх ${a.nIn}, пропущено ${a.inMissed}, номеров ${a.phones}`);
  };
  const seen = new Set<string>();
  for (const r of agg) {
    if (r.is_total) { cmp('Итого', toCallAgg(r), aggregateCallsJs(resolved)); continue; }
    seen.add(String(r.k));
    cmp(`${logists.get(String(r.k))?.name ?? r.k}`, toCallAgg(r), aggregateCallsJs(byKey.get(String(r.k)) ?? []));
  }
  for (const k of byKey.keys()) if (!seen.has(k)) { bad++; console.log(`DIFF ${logists.get(k)?.name ?? k}: есть в JS, нет в SQL`); }
  console.log(`период ${from}…${to}: звонков ${raw.length}, привязано к логистам ${resolved.length}, логистов со звонками ${byKey.size}, без логиста по карте ${unresolved}`);
} finally {
  c.release();
  await db.end();
}
console.log(`problems=${bad}`);
process.exit(bad ? 1 : 0);
