/**
 * Сверка группы «Звонки» (задача #8314) на живой базе: SQL_CALL_AGG (то, что считает
 * отчёт) против JS-эталона aggregateCallsJs по сырым строкам va.calls_logist — по каждому
 * ключу и по «Итого». Только чтение. Окружение — как у приложения (SA_PG_*).
 *   NODE_OPTIONS=--experimental-strip-types node --env-file=.env.local \
 *     --import ./scripts/ts-resolve-register.mjs scripts/check-logist-calls.ts 2026-09-30 2026-10-31
 */
import { sdDb } from '../lib/db/clients.ts';
import { SQL_CALL_AGG, SQL_CALL_LOGIST_MAP, aggregateCallsJs, callAttribution, toCallAgg, type CallAgg, type CallMapRow } from '../lib/realizations/callMetrics.ts';

const [from = '2026-09-30', to = '2026-12-31'] = process.argv.slice(2);
const db = sdDb();
const c = await db.connect();
let bad = 0;
try {
  await c.query('SET default_transaction_read_only = on');
  const map: CallMapRow[] = (await c.query(SQL_CALL_LOGIST_MAP)).rows.map(r => ({ logistId: r.logist_id, bitrixId: r.bitrix_id, name: r.name, verified: r.verified, load: r.load }));
  const owners = callAttribution(map);
  const uids = [...owners.keys()], keys = uids.map(u => owners.get(u)!.logistId);
  const agg = (await c.query(SQL_CALL_AGG, [from, to, uids, keys])).rows;
  const raw = (await c.query(`select portal_user_id::text uid, direction, duration_seconds, failed_code, transcription_status, phone from va.calls_logist
    where started_at >= ($1::date)::timestamp at time zone 'Europe/Moscow' and started_at < ($2::date + 1)::timestamp at time zone 'Europe/Moscow'
      and portal_user_id = any($3::bigint[])`, [from, to, uids])).rows;
  const byKey = new Map<string, typeof raw>();
  for (const r of raw) { const k = owners.get(r.uid)!.logistId; byKey.set(k, [...(byKey.get(k) ?? []), r]); }
  const cmp = (label: string, a: CallAgg, b: CallAgg) => {
    const diff = (Object.keys(a) as (keyof CallAgg)[]).filter(k => Math.abs(a[k] - b[k]) > 1e-9);
    if (diff.length) { bad++; console.log(`DIFF ${label}: ${diff.map(k => `${k} sql=${a[k]} js=${b[k]}`).join(', ')}`); }
    else console.log(`ok   ${label}: всего ${a.total}, исх ${a.nOut}, вх ${a.nIn}, пропущено ${a.inMissed}, номеров ${a.phones}`);
  };
  for (const r of agg) {
    if (r.is_total) cmp('Итого', toCallAgg(r), aggregateCallsJs(raw));
    else cmp(`${owners.get(uids[keys.indexOf(r.k)])?.name ?? r.k}`, toCallAgg(r), aggregateCallsJs(byKey.get(r.k) ?? []));
  }
  const unmapped = (await c.query(`select count(*)::int n from va.calls_logist where portal_user_id <> all($1::bigint[])`, [uids])).rows[0].n;
  console.log(`период ${from}…${to}: строк звонков ${raw.length}, ключей ${agg.length - 1}, звонков не-логистов (вне отчёта) ${unmapped}`);
} finally {
  c.release();
  await db.end();
}
console.log(`problems=${bad}`);
process.exit(bad ? 1 : 0);
