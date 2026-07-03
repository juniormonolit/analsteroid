// Разовый бэкфилл справочников контактов и компаний из Bitrix24 в БД system.
//
// Usage:
//   BITRIX_WEBHOOK_URL=https://portal.bitrix24.ru/rest/1/token node scripts/bitrix_backfill.mjs [contacts|companies|all]
//
// Щадящий режим: один HTTP-запрос к Bitrix раз в RATE_MS (default 1100ms),
// по 50 записей за запрос, без batch. Возобновляемый: продолжает с max(id) в таблице.

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const { Pool } = require('pg');

const WEBHOOK = (process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');
if (!WEBHOOK) {
  console.error('BITRIX_WEBHOOK_URL не задан');
  process.exit(1);
}
const RATE_MS = Number(process.env.RATE_MS || 1100);
const what = process.argv[2] || 'all';

const pool = new Pool({
  host: process.env.YC_PG_HOST,
  port: Number(process.env.YC_PG_PORT || 6432),
  user: process.env.YC_PG_USER,
  password: process.env.YC_PG_PASSWORD,
  database: process.env.YC_SYSTEM_DB || 'system',
  ssl: { ca: readFileSync('./certs/yandex-ca.pem', 'utf8'), rejectUnauthorized: false },
  max: 2,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Один вызов REST-метода. Fail-fast: максимум 3 попытки с щадящими паузами —
// если Битрикс не отвечает или троттлит дважды подряд, скрипт останавливается
// (упавший процесс = сигнал в чат), а не долбит портал ретраями.
async function bx(method, params) {
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const res = await fetch(`${WEBHOOK}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && !body.error) return body;
      const code = body?.error || `HTTP ${res.status}`;
      const retryable = code === 'QUERY_LIMIT_EXCEEDED' || res.status >= 500;
      if (!retryable) throw new Error(`FATAL ${method}: ${code} ${body?.error_description || ''}`);
      if (attempt === MAX) throw new Error(`FATAL ${method}: ${code} после ${MAX} попыток — Битрикс перегружен/недоступен, останавливаюсь`);
      const wait = code === 'QUERY_LIMIT_EXCEEDED' ? 60_000 : 20_000;
      console.warn(`[${method}] ${code}, пауза ${wait / 1000}s (попытка ${attempt}/${MAX})`);
      await sleep(wait);
    } catch (e) {
      if (e.message?.startsWith('FATAL')) throw e;
      if (attempt === MAX) throw new Error(`FATAL ${method}: сеть/таймаут: ${e.message} — Битрикс не отвечает, останавливаюсь`);
      console.warn(`[${method}] сеть/таймаут: ${e.message}, пауза 20s (попытка ${attempt}/${MAX})`);
      await sleep(20_000);
    }
  }
}

const multi = (arr) => JSON.stringify((arr || []).map((m) => m.VALUE).filter(Boolean));
const utm = (r) =>
  JSON.stringify({
    source: r.UTM_SOURCE || null,
    medium: r.UTM_MEDIUM || null,
    campaign: r.UTM_CAMPAIGN || null,
    content: r.UTM_CONTENT || null,
    term: r.UTM_TERM || null,
  });
const num = (v) => (v === '' || v == null ? null : Number(v));
const ts = (v) => (v ? v : null);

const ENTITIES = {
  contacts: {
    method: 'crm.contact.list',
    table: 'bitrix_contacts',
    select: [
      'ID', 'NAME', 'SECOND_NAME', 'LAST_NAME', 'COMPANY_ID', 'TYPE_ID',
      'SOURCE_ID', 'SOURCE_DESCRIPTION', 'POST', 'ASSIGNED_BY_ID', 'CREATED_BY_ID',
      'PHONE', 'EMAIL', 'DATE_CREATE', 'DATE_MODIFY',
      'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
    ],
    cols: ['id', 'name', 'second_name', 'last_name', 'company_id', 'type_id',
      'source_id', 'source_description', 'post', 'assigned_by_id', 'created_by_id',
      'phones', 'emails', 'utm', 'date_create', 'date_modify', 'raw'],
    row: (r) => [
      num(r.ID), r.NAME || null, r.SECOND_NAME || null, r.LAST_NAME || null,
      num(r.COMPANY_ID), r.TYPE_ID || null, r.SOURCE_ID || null,
      r.SOURCE_DESCRIPTION || null, r.POST || null, num(r.ASSIGNED_BY_ID),
      num(r.CREATED_BY_ID), multi(r.PHONE), multi(r.EMAIL), utm(r),
      ts(r.DATE_CREATE), ts(r.DATE_MODIFY), JSON.stringify(r),
    ],
  },
  companies: {
    method: 'crm.company.list',
    table: 'bitrix_companies',
    select: [
      'ID', 'TITLE', 'COMPANY_TYPE', 'INDUSTRY', 'EMPLOYEES', 'REVENUE', 'CURRENCY_ID',
      'ASSIGNED_BY_ID', 'CREATED_BY_ID', 'PHONE', 'EMAIL', 'WEB',
      'DATE_CREATE', 'DATE_MODIFY',
      'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
    ],
    cols: ['id', 'title', 'company_type', 'industry', 'employees', 'revenue',
      'currency_id', 'assigned_by_id', 'created_by_id', 'phones', 'emails', 'web',
      'utm', 'date_create', 'date_modify', 'raw'],
    row: (r) => [
      num(r.ID), r.TITLE || null, r.COMPANY_TYPE || null, r.INDUSTRY || null,
      r.EMPLOYEES || null, num(r.REVENUE), r.CURRENCY_ID || null,
      num(r.ASSIGNED_BY_ID), num(r.CREATED_BY_ID), multi(r.PHONE), multi(r.EMAIL),
      multi(r.WEB), utm(r), ts(r.DATE_CREATE), ts(r.DATE_MODIFY), JSON.stringify(r),
    ],
  },
};

async function upsert(table, cols, rows) {
  if (!rows.length) return;
  const width = cols.length;
  const placeholders = rows
    .map((_, i) => `(${cols.map((_, j) => `$${i * width + j + 1}`).join(',')})`)
    .join(',');
  const updates = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  await pool.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders}
     ON CONFLICT (id) DO UPDATE SET ${updates}, synced_at = now()`,
    rows.flat(),
  );
}

// Идём от самого большого ID к самому маленькому (order DESC, filter <ID).
// Возобновляемый: при рестарте продолжает вниз с min(id), уже лежащего в таблице.
async function backfill(kind) {
  const ent = ENTITIES[kind];
  const { rows } = await pool.query(`SELECT MIN(id) AS last, COUNT(*) AS n FROM ${ent.table}`);
  let lastId = rows[0].last == null ? null : Number(rows[0].last);
  let total = Number(rows[0].n);
  let milestone = Math.floor(total / 10000);
  const started = Date.now();
  console.log(`=== ${kind}: старт сверху вниз${lastId ? ` с ID < ${lastId}` : ''}, пауза ${RATE_MS}ms, уже в базе: ${total}`);

  for (;;) {
    const body = await bx(ent.method, {
      order: { ID: 'DESC' },
      filter: lastId ? { '<ID': lastId } : {},
      select: ent.select,
      start: -1,
    });
    const page = body.result || [];
    if (!page.length) break;
    await upsert(ent.table, ent.cols, page.map(ent.row));
    total += page.length;
    lastId = Number(page[page.length - 1].ID);
    if (Math.floor(total / 10000) > milestone) {
      milestone = Math.floor(total / 10000);
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`MILESTONE ${kind}: ${total} записей, дошли вниз до ID=${lastId}, ${mins} мин`);
    }
    if (page.length < 50) break;
    await sleep(RATE_MS);
  }
  console.log(`DONE ${kind}: всего ${total} записей за ${((Date.now() - started) / 60000).toFixed(1)} мин`);
}

try {
  if (what === 'all' || what === 'contacts') await backfill('contacts');
  if (what === 'all' || what === 'companies') await backfill('companies');
} finally {
  await pool.end();
}
