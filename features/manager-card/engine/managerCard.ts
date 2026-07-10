import { analyticsDb, systemDb } from '@/lib/db/clients';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { computeDelta } from '@/features/reports/engine/calculated';
import { fetchTouchSpeedAllByManager } from '@/features/reports/engine/callsMetrics';
import { branchLabel } from '@/lib/org/branchLabel';
import { toSqlInterval, type DateRange } from '@/lib/period';
import type { ClientType, ReportRow } from '@/lib/metrics/types';
import { getScoringWeights, type AxisKey as WeightAxisKey, type NormalizedWeights } from '@/lib/settings/scoringWeights';
import { differenceInCalendarDays, subDays, startOfDay } from 'date-fns';

// ─────────────────────────────────────────────────────────────────────────────
// Карточка менеджера (MVP, экран 1 мокапа manager-card-mock.html) — движок сборки
// данных: профиль, 6-метричная «паутина» (период + всё время, нормировка
// перцентилем 0-10 относительно менеджеров с продажами), рейтинг + ранг в отделе,
// итоги периода с Δ% к прошлому такому же периоду, топ-5 товарных категорий,
// тизер звонков (va.calls). Итерация 2 (карточка менеджера v2, бриф 10.07):
// ФИФА-сетка «Мой отдел» + карточка отдела (features/manager-card/engine/teamCard.ts)
// переиспользуют экспортированные отсюда AXIS_DEFS/buildAxisMap/percentileScore/
// ratingFor/rawAxisValues — единственный источник формулы рейтинга, чтобы сетка и
// карточка отдельного менеджера НИКОГДА не расходились в цифрах. Веса осей —
// настройка супер-админа (lib/settings/scoringWeights.ts, миграция 068).
// ─────────────────────────────────────────────────────────────────────────────

export type CardSegment = 'all' | 'fl' | 'ul';

export function segmentToClientType(seg: CardSegment): ClientType {
  return seg === 'fl' ? 'b2c' : seg === 'ul' ? 'b2b' : 'all';
}

// Период той же длины, непосредственно предшествующий текущему (для Δ%) — тот же
// принцип, что recomputeComparison (lib/period), но окно строго примыкающее, а не
// «хвост прошлого месяца» (там своя семантика для отчёта, здесь нужен буквально
// предыдущий период).
export function previousPeriod(period: DateRange): DateRange {
  const days = differenceInCalendarDays(period.to, period.from) + 1;
  const to = startOfDay(subDays(period.from, 1));
  const from = startOfDay(subDays(to, days - 1));
  return { from, to };
}

// «Всё время» — с заведомо ранней даты (данные компании не старше) до сейчас.
export const ALL_TIME: DateRange = { from: new Date('2015-01-01T00:00:00Z'), to: new Date() };

// ── 6 осей паутины ───────────────────────────────────────────────────────────
// AxisKey — каноничный тип из lib/settings/scoringWeights.ts (колонки scoring_weights
// должны совпадать буквально; там же лежит рантайм-список AXIS_KEYS для формы весов).
export type AxisKey = WeightAxisKey;

export interface AxisDef { key: AxisKey; label: string; unit: 'percent' | 'money' | 'minutes'; invert: boolean }

export const AXIS_DEFS: AxisDef[] = [
  { key: 'cr_deal_to_reservation', label: 'CR Сделка → Бронь',  unit: 'percent', invert: false },
  { key: 'cr_reservation_to_sale', label: 'CR Бронь → Продажа', unit: 'percent', invert: false },
  { key: 'sales_amount',           label: 'Сумма продаж',       unit: 'money',   invert: false },
  { key: 'avg_check',              label: 'Средний чек',        unit: 'money',   invert: false },
  { key: 'touch_speed',            label: 'Скорость касания',   unit: 'minutes', invert: true }, // меньше — лучше
  { key: 'refusal_rate',           label: 'Доля отказов',       unit: 'percent', invert: true }, // меньше — лучше
];

// Сырые значения 6 осей по строке отчёта (fetchByManagers всегда отдаёт ВСЕ
// collected-метрики независимо от запроса — см. features/reports/engine/byManagers.ts).
export function rawAxisValues(metrics: Record<string, number | null>, touchMinutes: number | null): Record<AxisKey, number | null> {
  const dealsCount        = metrics.deals_count ?? 0;
  const reservationsCount = metrics.reservations_count ?? 0;
  const salesCount        = metrics.sales_count ?? 0;
  const salesAmount       = (metrics.primary_sales_amount ?? 0) + (metrics.repeat_sales_amount ?? 0);
  const lostCount         = metrics.lost_deals_count ?? 0;
  return {
    cr_deal_to_reservation: dealsCount > 0 ? (reservationsCount / dealsCount) * 100 : null,
    cr_reservation_to_sale: reservationsCount > 0 ? (salesCount / reservationsCount) * 100 : null,
    sales_amount:           salesAmount,
    avg_check:              salesCount > 0 ? salesAmount / salesCount : null,
    touch_speed:            touchMinutes,
    refusal_rate:           dealsCount > 0 ? (lostCount / dealsCount) * 100 : null,
  };
}

export type AxisMap = Map<string, Record<AxisKey, number | null>>;

export function buildAxisMap(pool: ReportRow[], touchMap: Map<string, number> | null): AxisMap {
  const m: AxisMap = new Map();
  for (const row of pool) {
    const touch = touchMap?.get(row.dimensionId) ?? null;
    m.set(row.dimensionId, rawAxisValues(row.metrics, touch));
  }
  return m;
}

// Пул нормировки (п.6 ТЗ): «ВСЕ менеджеры с продажами за тот же период».
export function salesPositiveIds(pool: ReportRow[]): Set<string> {
  return new Set(pool.filter(r => (r.metrics.sales_count ?? 0) > 0).map(r => r.dimensionId));
}

export function poolValuesForAxis(axisMap: AxisMap, eligibleIds: Set<string>, axis: AxisKey): number[] {
  const out: number[] = [];
  for (const id of eligibleIds) {
    const v = axisMap.get(id)?.[axis];
    if (v !== null && v !== undefined) out.push(v);
  }
  return out;
}

// Перцентильная позиция значения в пуле → 0..10 (1 знак). Ничьи — средний ранг
// (полусумма «меньше»/«меньше-или-равно»). invert: для метрик «меньше — лучше»
// (скорость касания, доля отказов) переворачиваем шкалу.
export function percentileScore(raw: number | null, pool: number[], invert: boolean): number | null {
  if (raw === null || pool.length === 0) return null;
  let less = 0, equal = 0;
  for (const v of pool) {
    if (v < raw) less++;
    else if (v === raw) equal++;
  }
  const fracHigherBetter = (less + equal / 2) / pool.length;
  const frac = invert ? 1 - fracHigherBetter : fracHigherBetter;
  return Math.round(frac * 100) / 10;
}

// Рейтинг менеджера = взвешенное среднее нормированных (0-10) значений ДОСТУПНЫХ осей.
// Веса — настройка супер-админа (lib/settings/scoringWeights.ts, миграция 068,
// дефолт — равные, т.е. поведение как в v1 до появления настройки). Оси без данных
// (raw === null) исключаются из среднего (вес перенормируется на оставшиеся оси),
// а не считаются нулём — иначе отсутствие данных (напр. va.calls) необоснованно
// портило бы оценку.
export function ratingFor(axisMap: AxisMap, eligibleIds: Set<string>, managerId: string, weights: NormalizedWeights): number | null {
  const own = axisMap.get(managerId);
  if (!own) return null;
  const weighted: { score: number; weight: number }[] = [];
  for (const def of AXIS_DEFS) {
    const raw = own[def.key];
    if (raw === null) continue;
    const pool = poolValuesForAxis(axisMap, eligibleIds, def.key);
    const score = percentileScore(raw, pool, def.invert);
    if (score !== null) weighted.push({ score, weight: weights[def.key] });
  }
  const weightSum = weighted.reduce((s, w) => s + w.weight, 0);
  if (weighted.length === 0 || weightSum <= 0) return null;
  const value = weighted.reduce((s, w) => s + w.score * w.weight, 0) / weightSum;
  return Math.round(value * 10) / 10;
}

// ── va.calls (схема va, та же MLT-БД) ────────────────────────────────────────
// Скорость первого касания: медиана (created_at сделки → первый звонок result='completed',
// direction любой). Расчёт вынесен в features/reports/engine/callsMetrics.ts
// (задача КОЛСТАТ, 10.07, п.7 — используется ТАКЖЕ каталогом метрик «Звонки» с
// разрезом перв./повт./все; карточка менеджера как и раньше берёт только «(все)»).
// Если va.calls недоступна текущим подключением — ловим ошибку внутри
// fetchTouchSpeedAllByManager и получаем null (ось помечается «нет данных» выше
// по стеку, значения не выдумываются).
//
// Кэш (10 мин, тот же принцип, что row-кэш в byManagers.ts): результат зависит
// ТОЛЬКО от периода, не от менеджера — открытие карточки другого менеджера за тот
// же период (частый случай — ROP листает отдел) переиспользует уже посчитанное,
// не бьёт БД повторным сканом sa.deals ⋈ va.calls на каждое открытие панели.
const _touchSpeedCache = new Map<string, { data: Map<string, number> | null; at: number }>();
const TOUCH_SPEED_TTL = 10 * 60 * 1000;

export async function fetchTouchSpeedByManager(period: DateRange): Promise<Map<string, number> | null> {
  const { from, toExcl } = toSqlInterval(period);
  const cacheKey = `${from}|${toExcl}`;
  const cached = _touchSpeedCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TOUCH_SPEED_TTL) return cached.data;

  const data = await fetchTouchSpeedAllByManager(period);
  _touchSpeedCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

interface CallsTizer { count: number; avgDurationSec: number | null }

// Тизер звонков одного менеджера за период: кол-во (любой результат), средняя
// продолжительность (только completed — у missed длительность не осмысленна).
async function fetchCallsTizer(managerIdNum: number, period: DateRange): Promise<CallsTizer | null> {
  try {
    const { from, toExcl } = toSqlInterval(period);
    const res = await analyticsDb().query<{ total: string; avg_duration: string | null }>(
      `SELECT count(*)::text AS total,
              avg(duration_seconds) FILTER (WHERE result = 'completed') AS avg_duration
       FROM va.calls
       WHERE manager_id = $1 AND called_at >= $2 AND called_at < $3`,
      [managerIdNum, from, toExcl],
    );
    const row = res.rows[0];
    if (!row) return { count: 0, avgDurationSec: null };
    return {
      count: Number(row.total),
      avgDurationSec: row.avg_duration !== null ? Number(row.avg_duration) : null,
    };
  } catch (e) {
    console.warn('[manager-card] va.calls (тизер) недоступна:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Итоги периода (плитки) ───────────────────────────────────────────────────
interface TileMetricValue { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }

function tileRaw(row: ReportRow | undefined) {
  const m = row?.metrics ?? {};
  const salesAmount = (m.primary_sales_amount ?? 0) + (m.repeat_sales_amount ?? 0);
  const salesCount  = m.sales_count ?? 0;
  return {
    reservations:          m.reservations_count ?? 0,
    confirmedReservations: m.confirmed_reservations_count ?? 0,
    salesCount,
    salesAmount,
    shipments:             m.shipments_count ?? 0,
    avgCheck:              salesCount > 0 ? salesAmount / salesCount : null,
  };
}

function tileValue(current: number | null, comparison: number | null): TileMetricValue {
  return { current, comparison, ...computeDelta(current, comparison) };
}

// ── Категории (топ-5 по доле суммы продаж) ───────────────────────────────────
export interface CategoryShare { name: string; amount: number; share: number }

// ── Публичный контракт ───────────────────────────────────────────────────────
export interface ManagerCardOptions {
  managerId: string;
  period: DateRange;
  segment: CardSegment;
}

export interface AxisResult {
  key: AxisKey;
  label: string;
  unit: 'percent' | 'money' | 'minutes';
  invert: boolean;
  period:  { raw: number | null; normalized: number | null };
  allTime: { raw: number | null; normalized: number | null };
  dataAvailable: boolean;
}

export interface ManagerCardResult {
  profile: {
    managerId: string;
    name: string;
    login: string | null;
    department: string | null;
    branch: string | null;
  };
  rating: { value: number | null; rank: number | null; deptSize: number };
  radar: { axes: AxisResult[] };
  totals: {
    reservations: TileMetricValue;
    confirmedReservations: TileMetricValue;
    salesCount: TileMetricValue;
    salesAmount: TileMetricValue;
    shipments: TileMetricValue;
    avgCheck: TileMetricValue;
  };
  categories: CategoryShare[];
  calls: (CallsTizer & { medianFirstTouchMinutes: number | null }) | null;
  meta: { period: { from: string; to: string }; comparisonPeriod: { from: string; to: string }; touchSpeedAvailable: boolean };
}

export async function buildManagerCard(opts: ManagerCardOptions): Promise<ManagerCardResult | { error: string }> {
  const { managerId, period, segment } = opts;
  const clientType = segmentToClientType(segment);
  const prevPeriod = previousPeriod(period);

  const sysDb = systemDb();
  const orgRes = await sysDb.query<{
    bitrix_user_id: string; manager_name: string; department_id: string | null;
    department_name: string | null; branch: string | null; short_login: string | null;
  }>(
    `SELECT manager_bitrix_user_id::text AS bitrix_user_id, manager_name, department_id,
            department_name, branch, short_login
       FROM org_resolved_hierarchy
      WHERE manager_bitrix_user_id::text = $1 AND is_active = true`,
    [managerId],
  );
  const org = orgRes.rows[0];
  if (!org) return { error: 'Менеджер не найден в активной оргструктуре' };

  const managerIdNum = /^\d+$/.test(managerId) ? Number(managerId) : null;

  const [periodPool, prevPool, allTimePool, touchPeriodMap, touchAllTimeMap, deptRosterRes, callsTizer, pgRows, weights] =
    await Promise.all([
      fetchByManagers({ period, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchByManagers({ period: prevPeriod, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchByManagers({ period: ALL_TIME, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchTouchSpeedByManager(period),
      fetchTouchSpeedByManager(ALL_TIME),
      org.department_id
        ? sysDb.query<{ bitrix_user_id: string }>(
            `SELECT manager_bitrix_user_id::text AS bitrix_user_id
               FROM org_resolved_hierarchy WHERE department_id = $1 AND is_active = true`,
            [org.department_id],
          )
        : Promise.resolve({ rows: [{ bitrix_user_id: managerId }] }),
      managerIdNum !== null ? fetchCallsTizer(managerIdNum, period) : Promise.resolve(null),
      fetchByProductGroups({ period, dealScope: 'all', clientType, productGroupMode: 'kc', managerId }),
      getScoringWeights(),
    ]);

  const currentRow = periodPool.find(r => r.dimensionId === managerId);
  const prevRow    = prevPool.find(r => r.dimensionId === managerId);

  // ── Паутина: 6 осей, период + всё время, перцентильная нормировка ─────────
  const periodAxisMap  = buildAxisMap(periodPool, touchPeriodMap);
  const allTimeAxisMap = buildAxisMap(allTimePool, touchAllTimeMap);
  const periodEligible  = salesPositiveIds(periodPool);
  const allTimeEligible = salesPositiveIds(allTimePool);

  const axes: AxisResult[] = AXIS_DEFS.map(def => {
    const periodOwn  = periodAxisMap.get(managerId)?.[def.key] ?? null;
    const allTimeOwn = allTimeAxisMap.get(managerId)?.[def.key] ?? null;
    return {
      key: def.key, label: def.label, unit: def.unit, invert: def.invert,
      period: {
        raw: periodOwn,
        normalized: percentileScore(periodOwn, poolValuesForAxis(periodAxisMap, periodEligible, def.key), def.invert),
      },
      allTime: {
        raw: allTimeOwn,
        normalized: percentileScore(allTimeOwn, poolValuesForAxis(allTimeAxisMap, allTimeEligible, def.key), def.invert),
      },
      // Скорость касания зависит от va.calls; остальные 5 — от sa.deals (всегда доступна).
      dataAvailable: def.key === 'touch_speed' ? touchPeriodMap !== null : true,
    };
  });

  // ── Рейтинг + ранг в отделе ─────────────────────────────────────────────────
  const rating = ratingFor(periodAxisMap, periodEligible, managerId, weights);
  const deptMemberIds = deptRosterRes.rows.map(r => r.bitrix_user_id);
  const deptSize = deptMemberIds.length || 1;
  const deptRatings = deptMemberIds.map(id => ({
    id,
    rating: id === managerId ? rating : ratingFor(periodAxisMap, periodEligible, id, weights),
  }));
  const withRating = deptRatings.filter(r => r.rating !== null).sort((a, b) => (b.rating! - a.rating!));
  const withoutRating = deptRatings.filter(r => r.rating === null);
  const orderedIds = [...withRating.map(r => r.id), ...withoutRating.map(r => r.id)];
  const rankIdx = orderedIds.indexOf(managerId);
  const rank = rankIdx >= 0 ? rankIdx + 1 : null;

  // ── Итоги периода (плитки) с Δ% к прошлому такому же периоду ────────────────
  const cur  = tileRaw(currentRow);
  const prev = tileRaw(prevRow);
  const totals = {
    reservations:          tileValue(cur.reservations, prev.reservations),
    confirmedReservations: tileValue(cur.confirmedReservations, prev.confirmedReservations),
    salesCount:            tileValue(cur.salesCount, prev.salesCount),
    salesAmount:           tileValue(cur.salesAmount, prev.salesAmount),
    shipments:             tileValue(cur.shipments, prev.shipments),
    avgCheck:              tileValue(cur.avgCheck, prev.avgCheck),
  };

  // ── Топ-5 товарных категорий по доле суммы продаж ───────────────────────────
  const categoriesAll = pgRows
    .map(r => ({ name: r.dimensionName, amount: (r.metrics.primary_sales_amount ?? 0) + (r.metrics.repeat_sales_amount ?? 0) }))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const totalAmount = categoriesAll.reduce((s, r) => s + r.amount, 0);
  const categories: CategoryShare[] = categoriesAll.slice(0, 5).map(r => ({
    name: r.name, amount: r.amount, share: totalAmount > 0 ? Math.round((r.amount / totalAmount) * 1000) / 10 : 0,
  }));

  const touchPeriodOwn = touchPeriodMap?.get(managerId) ?? null;

  return {
    profile: {
      managerId,
      name: org.manager_name,
      login: org.short_login,
      department: org.department_name,
      branch: branchLabel(org.branch),
    },
    rating: { value: rating, rank, deptSize },
    radar: { axes },
    totals,
    categories,
    calls: callsTizer ? { ...callsTizer, medianFirstTouchMinutes: touchPeriodOwn } : null,
    meta: {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      comparisonPeriod: { from: prevPeriod.from.toISOString(), to: prevPeriod.to.toISOString() },
      touchSpeedAvailable: touchPeriodMap !== null,
    },
  };
}
