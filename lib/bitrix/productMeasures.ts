// Единицы измерения товаров (25.11, Коваленко: «добавь в повторные продажи объём/кол-во отгруженного и проданного
// товара»). В копии сделок (sa.deals.products) количество есть, единицы нет — берём её из товарных строк Битрикса
// (crm.deal.productrows.get → MEASURE_NAME) и запоминаем ПО ТОВАРУ: единица товара не меняется, поэтому каждый
// товар спрашиваем у Битрикса один раз, дальше — из Redis (без Redis — из памяти процесса).
import { bx } from './notify';
import { getRedis } from '@/lib/cache/redis';

const KEY = 'bx:product-measure';
const mem = new Map<number, string>();
/** Сколько сделок спрашиваем за одно открытие (batch по 50); остальные — при следующих открытиях. */
const DEAL_LIMIT = 100;

async function readKnown(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const miss: number[] = [];
  for (const id of ids) { const m = mem.get(id); if (m !== undefined) out.set(id, m); else miss.push(id); }
  const r = getRedis();
  if (r && miss.length) {
    const vals = await r.hmget(KEY, ...miss.map(String)).catch(() => [] as (string | null)[]);
    miss.forEach((id, i) => { const v = vals[i]; if (v != null) { out.set(id, v); mem.set(id, v); } });
  }
  return out;
}

async function remember(found: Map<number, string>): Promise<void> {
  for (const [id, m] of found) mem.set(id, m);
  const r = getRedis();
  if (r && found.size) await r.hset(KEY, Object.fromEntries([...found].map(([k, v]) => [String(k), v]))).catch(() => {});
}

/** Единица по id товара для товаров этих сделок. `deals` — сделка и id её товаров (из sa.deals.products). */
export async function productMeasures(deals: { dealId: number; productIds: number[] }[]): Promise<Map<number, string>> {
  const all = [...new Set(deals.flatMap(d => d.productIds))].filter(id => id > 0);
  if (!all.length) return new Map();
  const known = await readKnown(all);
  const webhook = process.env.BITRIX_WEBHOOK_URL || '';
  const ask = deals.filter(d => d.productIds.some(id => id > 0 && !known.has(id))).slice(0, DEAL_LIMIT).map(d => d.dealId);
  if (!webhook || !ask.length) return known;
  const found = new Map<number, string>();
  try {
    for (let i = 0; i < ask.length; i += 50) {
      const chunk = ask.slice(i, i + 50);
      const body = await bx(webhook, 'batch', { halt: 0, cmd: Object.fromEntries(chunk.map(id => [`d${id}`, `crm.deal.productrows.get?id=${id}`])) });
      const res = (body?.result?.result ?? {}) as Record<string, { PRODUCT_ID?: string | number; MEASURE_NAME?: string | null }[]>;
      for (const rows of Object.values(res)) for (const row of rows ?? []) {
        const id = Number(row.PRODUCT_ID), m = (row.MEASURE_NAME ?? '').trim();
        if (id > 0 && m) found.set(id, m);
      }
    }
  } catch (e) {
    console.warn('[productMeasures] Битрикс не ответил:', e instanceof Error ? e.message : e);
  }
  await remember(found);
  for (const [id, m] of found) known.set(id, m);
  return known;
}
