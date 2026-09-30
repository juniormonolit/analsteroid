import { stub } from './state.ts';

function fakePool() {
  const query = async (sql: string, params: unknown[] = []) => {
    stub().queries.push({ sql, params });
    const r = stub().query(sql, params) ?? { rows: [] };
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }) };
}
export const systemDb = fakePool;
export const analyticsDb = fakePool;
export const ycAnalyticsDb = fakePool;
export const sdDb = fakePool;
