// REST Битрикса для канбана больших чеков: batch (до 50 команд за HTTP-вызов) поверх bx().
import { bx } from '@/lib/bitrix/notify';
import { taskWebhook } from '@/features/repeat-kanban/engine/createDeal';

export function crmReadWebhook(): string {
  return (process.env.BITRIX_WEBHOOK_URL_2 || process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');
}
export { taskWebhook };

/** PHP-подобная сериализация параметров для команды batch: filter[>=X]=1&select[]=ID. */
export function qs(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${prefix}[${k}]`, x);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join('&');
}

export interface BatchCmd { method: string; params: Record<string, unknown> }
export interface BatchOut<T> { result: Record<string, T>; total: Record<string, number>; errors: Record<string, unknown> }

/** Выполняет любое число команд пачками по perCall (≤50; пачки — параллельно по 3). Тяжёлые команды —
 *  мельче пачки: Битрикс выполняет команды внутри batch последовательно, а bx() ждёт ответа 60 с. */
export async function bxBatch<T = unknown>(webhook: string, cmds: Record<string, BatchCmd>, perCall = 50): Promise<BatchOut<T>> {
  const keys = Object.keys(cmds);
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += perCall) chunks.push(keys.slice(i, i + perCall));
  const out: BatchOut<T> = { result: {}, total: {}, errors: {} };
  for (let i = 0; i < chunks.length; i += 3) {
    await Promise.all(chunks.slice(i, i + 3).map(async ch => {
      const cmd: Record<string, string> = {};
      for (const k of ch) cmd[k] = `${cmds[k].method}?${qs(cmds[k].params)}`;
      const body = await bx(webhook, 'batch', { halt: 0, cmd }) as {
        result: { result: Record<string, T> | T[]; result_total?: Record<string, number> | unknown[]; result_error?: Record<string, unknown> | unknown[] };
      };
      const r = body.result ?? { result: {} };
      if (r.result && !Array.isArray(r.result)) Object.assign(out.result, r.result);
      if (r.result_total && !Array.isArray(r.result_total)) Object.assign(out.total, r.result_total);
      if (r.result_error && !Array.isArray(r.result_error)) Object.assign(out.errors, r.result_error);
    }));
  }
  if (Object.keys(out.errors).length) console.warn('[big-deals] batch errors', JSON.stringify(out.errors).slice(0, 500));
  return out;
}
