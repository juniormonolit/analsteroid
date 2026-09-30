/**
 * Проверка ДО выката #8256: все сохранённые метрики (таблица metrics) проходят
 * новые правила sqlGen / metricValidation (находка аудита D3). Только чтение
 * (default_transaction_read_only). Код выхода 1 — есть метрики, которые после
 * выката перестанут считаться; их нужно поправить до выката.
 *
 * Запуск с окружением приложения (те же YC_PG_* что у сервиса):
 *   NODE_OPTIONS=--experimental-strip-types \
 *     node --import ./scripts/ts-resolve-register.mjs scripts/check-metric-definitions.ts
 */
import { ycAnalyticsDb } from '../lib/db/clients.ts';
import { metricDefinitionError } from '../lib/metrics/metricValidation.ts';
import { resolveFilterClause } from '../lib/metrics/sqlGen.ts';

const c = await ycAnalyticsDb().connect();
let bad = 0;
let total = 0;
try {
  await c.query('SET default_transaction_read_only = on');
  const r = await c.query<{ id: string; agg_field: string | null; date_field: string | null; filters: unknown[] }>(
    `SELECT id, agg_field, date_field, COALESCE(filters, '[]'::jsonb) AS filters FROM metrics`,
  );
  total = r.rows.length;
  for (const row of r.rows) {
    const e = metricDefinitionError(row as unknown as Record<string, unknown>, { requireId: true });
    if (e) { bad++; console.log(`DEF    ${row.id}: ${e}`); continue; }
    for (const f of row.filters ?? []) {
      try { resolveFilterClause(f as never, 'd'); } catch (err) { bad++; console.log(`CLAUSE ${row.id}: ${(err as Error).message}`); }
    }
  }
} finally {
  c.release();
}
console.log(`metrics=${total} problems=${bad}`);
process.exit(bad ? 1 : 0);
