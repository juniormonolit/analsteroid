// «Большой брат» → «РОПы»: активность РОПа × динамика отдела с лагом (итерация 26.11). Корреляция, не рейтинг:
// РОПов мало, точки — пары (РОП, неделя N). В балл не суммируется.
//
// x — задач РОПа на подчинённого за неделю N (все три сервиса, как в рейтинге).
// y — изменение продаж отдела (подчинённые + РОП): неделя N+lag против среднего за недели N−2…N, в %.
// Продажи по неделям — fetchMetricSeries (тот же генератор SQL, что отчёт «По менеджерам»; сверено 25.11:
// неделя 16–22.11 у менеджера 1848 — 84 000 + 197 100 = 281 100, как в отчёте), primary + repeat sales amount.
// Только завершённые недели. Кэш — 1 ч (прошлые недели почти не меняются).
import { fetchMetricSeries } from '@/features/reports/engine/metricSeries';
import { loadRopTasks, loadTeams } from './sources';
import { addDays, mskDay, weekStart } from './period';
import type { LagPoint, RopLagResponse } from './types';

const SALES_WEEKS = 18;
const BASE_WEEKS = 3; // N−2…N
const TTL_MS = 60 * 60_000;
let salesCache: { at: number; p: Promise<{ weeks: string[]; byRop: Map<string, Map<string, number>> }> } | null = null;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

function weeklySales(teams: Map<string, string[]>, firstWeek: string, lastWeek: string) {
  if (salesCache && Date.now() - salesCache.at < TTL_MS) return salesCache.p;
  const p = (async () => {
    const weeks: string[] = [];
    for (let w = firstWeek; w <= lastWeek; w = addDays(w, 7)) weeks.push(w);
    const period = { from: new Date(`${firstWeek}T00:00:00+03:00`), to: new Date(`${addDays(lastWeek, 6)}T23:59:59.999+03:00`) };
    const entries = [...teams.entries()];
    const byRop = new Map<string, Map<string, number>>();
    await mapLimit(entries, 4, async ([rop, members]) => {
      const m = new Map<string, number>();
      for (const metricId of ['primary_sales_amount', 'repeat_sales_amount']) {
        const s = await fetchMetricSeries({ metricId, period, granularity: 'week', dealScope: 'all', managerIds: members });
        for (const b of s.buckets) m.set(b.bucket, (m.get(b.bucket) ?? 0) + (b.value ?? 0));
      }
      byRop.set(rop, m);
    });
    return { weeks, byRop };
  })();
  salesCache = { at: Date.now(), p };
  p.catch(() => { salesCache = null; });
  return p;
}

function pearson(pts: { x: number; y: number }[]): number | null {
  if (pts.length < 5) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export async function buildRopLag(lag: number, now = Date.now()): Promise<RopLagResponse> {
  const { byId, teams } = await loadTeams();
  const lastWeek = addDays(weekStart(mskDay(now)), -7); // последняя завершённая
  const firstWeek = addDays(lastWeek, -(SALES_WEEKS - 1) * 7);
  const teamIds = new Map([...teams].map(([rop, list]) => [rop, [rop, ...list.map(p => p.id)]]));
  const [{ weeks, byRop }, act] = await Promise.all([
    weeklySales(teamIds, firstWeek, lastWeek),
    loadRopTasks([...teams.keys()], `${firstWeek}T00:00:00+03:00`, `${addDays(lastWeek, 7)}T00:00:00+03:00`),
  ]);
  const tasksBy = new Map<string, number>();
  for (const t of act.tasks) {
    const k = `${t.creatorId}:${weekStart(mskDay(t.createdAt))}`;
    tasksBy.set(k, (tasksBy.get(k) ?? 0) + 1);
  }
  const points: LagPoint[] = [];
  const xWeeks: string[] = [];
  for (let i = BASE_WEEKS - 1; i + lag < weeks.length; i++) {
    const w = weeks[i];
    xWeeks.push(w);
    for (const [rop, list] of teams) {
      const sales = byRop.get(rop);
      if (!sales || !list.length) continue;
      const base = weeks.slice(i - BASE_WEEKS + 1, i + 1).reduce((s, x) => s + (sales.get(x) ?? 0), 0) / BASE_WEEKS;
      if (base <= 0) continue;
      const after = sales.get(weeks[i + lag]) ?? 0;
      points.push({
        ropId: rop, name: byId.get(rop)?.name ?? list[0]?.ropName ?? `#${rop}`, week: w,
        x: (tasksBy.get(`${rop}:${w}`) ?? 0) / list.length, y: after / base - 1,
      });
    }
  }
  return {
    lag, weeks: xWeeks, points, r: pearson(points), rops: new Set(points.map(p => p.ropId)).size,
    notes: [
      'Корреляция, не рейтинг: РОПов мало, недели одного РОПа не независимы, продажи зависят от многого кроме задач.',
      `Точка — РОП и неделя N. X — задач на подчинённого за неделю N; Y — продажи отдела в неделю N+${lag} против среднего за N−2…N.`,
      'Активность РОПа в самой Монолитике (минуты, просмотры) добавится сюда, когда журналу будет 4+ недели: нужны недели «после».',
    ],
  };
}
