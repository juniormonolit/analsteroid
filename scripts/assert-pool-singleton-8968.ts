// #8968: пулы кэшируются в globalThis; max берётся из env. БД не нужна (pg.Pool ленивый).
import assert from 'node:assert/strict';
process.env.SA_PG_USER = 'x'; process.env.SA_PG_PASSWORD = 'x';
process.env.YC_PG_HOST = 'localhost'; process.env.YC_PG_USER = 'x'; process.env.YC_PG_PASSWORD = 'x';
process.env.YC_PG_POOL_MAX = '5';
import fs from 'node:fs';
// Второй экземпляр модуля (копия файла), как другой чанк Next / HMR-перезагрузка.
const copy = new URL('../lib/db/clients.copy-test.ts', import.meta.url);
fs.copyFileSync(new URL('../lib/db/clients.ts', import.meta.url), copy);
const a = await import('../lib/db/clients.ts');
const b = await import('../lib/db/clients.copy-test.ts');
fs.unlinkSync(copy);
assert.notEqual(a, b);
assert.equal(a.analyticsDb(), b.analyticsDb());
assert.equal(a.ycAnalyticsDb(), b.ycAnalyticsDb());
assert.equal(a.systemDb(), b.systemDb());
assert.equal((a.analyticsDb() as any).options.max, 8);
assert.equal((a.analyticsDb() as any).options.idleTimeoutMillis, 10000);
assert.equal((a.ycAnalyticsDb() as any).options.max, 5);
console.log('OK pool singleton, max sa=8 yc=5');
process.exit(0);
