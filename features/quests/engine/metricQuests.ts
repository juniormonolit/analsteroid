// Универсальный вычислитель квестов на ПРОИЗВОЛЬНОЙ метрике каталога
// (задача 60, «конструктор уровня 3»).
//
// Встроенные шесть-семь категорий квестов — это switch со своей логикой у
// каждой. Чтобы владелец мог собрать квест на любую метрику из `metrics`, нужен
// один вычислитель, который умеет три вещи для пары (метрика × период):
//
//   1. значение у КОНКРЕТНОГО менеджера за окно квеста — прогресс;
//   2. ряд значений менеджера по прошлым периодам — личная планка (p75/медиана);
//   3. ряд значений по всем менеджеро-периодам — медиана компании (тир и пол).
//
// Все три считаются ОДНИМ И ТЕМ ЖЕ SQL, что строит ячейку отчёта
// (`buildCollectedSQL` из lib/metrics/sqlGen) — параллельных формул нет, иначе
// «квест выполнен» и «в отчёте другое число» разъедутся в первую же неделю.
//
// Поддержаны: collected-метрики источника `deals` и calculated поверх таких —
// ровно та же граница, что у графика метрики (`seriesDeps` в metricSeries.ts,
// оттуда и берём проверку). Метрики по deal_events, external (планы, звонки,
// снимки стадий) не поддержаны: у них свои движки без универсальной разбивки
// по (менеджер × период).

import { analyticsDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { computeCalculated } from '@/features/reports/engine/calculated';
import { seriesDeps } from '@/features/reports/engine/metricSeries';
import { cached } from '@/lib/cache/redis';
import type { Metric } from '@/lib/metrics/types';

const MSK = 'Europe/Moscow';

export type MetricUnit = 'day' | 'week' | 'month';

/** Метрика каталога, пригодная для квеста. null — не поддержана. */
export async function resolveQuestMetric(metricId: string): Promise<{ metric: Metric; deps: Metric[] } | null> {
  const all = await loadMetrics();
  const metric = all.find(m => m.id === metricId);
  if (!metric) return null;
  const d = seriesDeps(metric, all);
  return d ? { metric, deps: d.deps } : null;
}

/** Список метрик каталога, на которых можно построить квест (для конструктора). */
export async function listQuestableMetrics(): Promise<Metric[]> {
  const all = await loadMetrics();
  return all.filter(m => !m.isHiddenInUi && m.isActive && seriesDeps(m, all) !== null);
}

// МСК-полночь даты в ISO — те же границы, что у отчётов (from включительно,
// toExcl исключительно).
function mskMidnight(ymd: string): string {
  return new Date(`${ymd}T00:00:00+03:00`).toISOString();
}
function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

interface Sample { mgr: number; bucket: string; value: number }

/** Значения метрики по (менеджер × бакет) за окно [fromYmd, toYmd] включительно.
 *
 *  `unit='none'` — один бакет на всё окно (режим прогресса квеста).
 *  Метрика с несколькими collected-зависимостями считается как в отчёте:
 *  каждая зависимость собирается СВОИМ `date_field` (у продаж и броней даты
 *  разные), суммы складываются в общую корзину, формула применяется к суммам. */
async function sampleMetric(
  metric: Metric, deps: Metric[], unit: MetricUnit | 'none',
  fromYmd: string, toYmdIncl: string, mgrIds?: number[],
): Promise<Sample[]> {
  const fromIso = mskMidnight(fromYmd);
  const toExclIso = mskMidnight(nextDay(toYmdIncl));
  // sums[`${mgr}|${bucket}`][depId]
  const sums = new Map<string, Record<string, number | null>>();

  for (const dep of deps) {
    const bucketExpr = unit === 'none'
      ? `'all'`
      : `to_char(date_trunc('${unit}', (d.${dep.dateField} AT TIME ZONE '${MSK}')), 'YYYY-MM-DD')`;
    const where = [
      'd.current_manager_id IS NOT NULL',
      mgrIds && mgrIds.length > 0 ? `d.current_manager_id = ANY('{${mgrIds.join(',')}}'::bigint[])` : '',
    ].filter(Boolean).join(' AND ');
    const sql = buildCollectedSQL([dep], {
      idExpr: `d.current_manager_id::text || '|' || ${bucketExpr}`,
      groupBy: 'GROUP BY 1',
      notNullWhere: where,
    });
    if (!sql) continue;
    const res = await analyticsDb().query<Record<string, unknown> & { dimension_id: string }>(
      sql, [fromIso, toExclIso],
    );
    for (const row of res.rows) {
      const v = row[dep.id];
      if (v === null || v === undefined) continue;
      const key = row.dimension_id;
      const entry = sums.get(key) ?? sums.set(key, {}).get(key)!;
      entry[dep.id] = (entry[dep.id] ?? 0) + Number(v);
    }
  }

  const out: Sample[] = [];
  for (const [key, entry] of sums) {
    const sep = key.indexOf('|');
    const mgr = Number(key.slice(0, sep));
    const bucket = key.slice(sep + 1);
    if (!Number.isFinite(mgr)) continue;
    let value: number | null;
    if (metric.metricType === 'calculated') {
      const filled: Record<string, number | null> = {};
      for (const dep of deps) filled[dep.id] = entry[dep.id] ?? 0;
      value = computeCalculated(filled, [metric])[metric.id] ?? null;
    } else {
      value = entry[metric.id] ?? null;
    }
    if (value === null || !Number.isFinite(value)) continue;
    out.push({ mgr, bucket, value });
  }
  return out;
}

/** Прогресс квеста на метрике: значение у менеджера за окно квеста. */
export async function metricQuestProgress(
  metricId: string, mgr: number, fromYmd: string, toYmdIncl: string,
): Promise<number> {
  const r = await resolveQuestMetric(metricId);
  if (!r) return 0;
  const s = await sampleMetric(r.metric, r.deps, 'none', fromYmd, toYmdIncl, [mgr]);
  return s[0]?.value ?? 0;
}

/** Личный ряд метрики по последним ПОЛНЫМ периодам (для планки p75/медианы).
 *  Периодов берём 6 недель / 6 месяцев / 30 дней — как у встроенных категорий. */
export async function metricPersonalSeries(
  metricId: string, mgr: number, unit: MetricUnit, today: string,
): Promise<number[]> {
  const r = await resolveQuestMetric(metricId);
  if (!r) return [];
  const { from, to } = pastWindow(unit, today);
  const s = await sampleMetric(r.metric, r.deps, unit, from, to, [mgr]);
  return s.sort((a, b) => a.bucket.localeCompare(b.bucket)).map(x => x.value);
}

/** Медиана компании по (менеджер × период) — база тира и пол цели.
 *  Redis 6ч на пару (метрика × период), как у встроенных медиан. */
export async function metricCompanyMedian(
  metricId: string, unit: MetricUnit, today: string,
): Promise<number> {
  return cached(`quests:metric-median:v1:${metricId}:${unit}`, 6 * 3600, async () => {
    const r = await resolveQuestMetric(metricId);
    if (!r) return 0;
    const { from, to } = pastWindow(unit, today);
    const s = await sampleMetric(r.metric, r.deps, unit, from, to);
    // Нулевые менеджеро-периоды в выборку не попадают вовсе (их нет в deals) —
    // медиана считается по периодам С АКТИВНОСТЬЮ, ровно как у встроенных
    // категорий. Иначе половина компании, не трогавшая метрику, утянула бы
    // базу в ноль и любая цель стала бы легендарной.
    const vals = s.map(x => x.value).sort((a, b) => a - b);
    if (vals.length === 0) return 0;
    const m = vals.length >> 1;
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  });
}

/** Окно прошлых ПОЛНЫХ периодов: 6 недель / 6 месяцев / 30 дней до сегодня. */
function pastWindow(unit: MetricUnit, today: string): { from: string; to: string } {
  const d = new Date(`${today}T12:00:00Z`);
  if (unit === 'day') {
    const from = new Date(d); from.setUTCDate(from.getUTCDate() - 30);
    const to = new Date(d); to.setUTCDate(to.getUTCDate() - 1);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }
  if (unit === 'week') {
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    const curMon = new Date(d); curMon.setUTCDate(curMon.getUTCDate() + 1 - dow);
    const from = new Date(curMon); from.setUTCDate(from.getUTCDate() - 42);
    const to = new Date(curMon); to.setUTCDate(to.getUTCDate() - 1);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }
  const curFirst = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12));
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, 1, 12));
  const to = new Date(curFirst); to.setUTCDate(to.getUTCDate() - 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
