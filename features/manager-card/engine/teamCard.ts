// Карточка менеджера v2 (бриф 10.07): движок ФИФА-сетки «Мой отдел» (ЛК РОПа/Директора/
// Админа/супер-админа) и агрегированной «Карточки отдела». Переиспользует единственный
// источник правды на формулу рейтинга/паутины из features/manager-card/engine/managerCard.ts
// (AXIS_DEFS/buildAxisMap/percentileScore/ratingFor — те же функции, что и карточка
// одного менеджера, поэтому цифры НИКОГДА не расходятся между экранами).
//
// ─── Сетка «Мой отдел» ──────────────────────────────────────────────────────────
// Рейтинг/паутина каждого менеджера в сетке нормируются относительно ТОГО ЖЕ пула,
// что и в карточке v1 — «все менеджеры компании с продажами за период» (НЕ только
// отдел), поэтому цифра рейтинга менеджера в сетке = цифра в его большой карточке
// (проверено живым сравнением, см. WORKLOG/отчёт задачи). N+1 избегается: пул
// (fetchByManagers) и веса читаются ОДИН раз на весь отдел, а не по менеджеру.
//
// ─── Карточка отдела ────────────────────────────────────────────────────────────
// Отдел трактуется как «виртуальный менеджер»: сырые компоненты (сделки/брони/
// продажи/сумма/отказы) СУММИРУЮТСЯ по всем менеджерам отдела, из суммы заново
// считаются проценты/средний чек (а не усредняются готовые проценты — иначе средний
// чек команды из 2 человек с чеками 100 и 900 тыс. стал бы 500, а не честной суммой/
// количеством). Нормировка рейтинга отдела — относительно ДРУГИХ отделов (тот же
// peer-набор, что getAllManagedDepartmentIds: все department_id, назначенные хоть
// кому-то через «Руководит», плюс корневые узлы дерева). Если пиров меньше 2
// (сравнивать не с кем) — rating.value/rank = null → UI (ManagerCardPanel) уже
// умеет рисовать «—» для null, отдельного экрана не потребовалось.
// Скорость касания отдела — СРЕДНЕЕ доступных медиан менеджеров (не пересчитывается
// из сырых звонков) — упрощение, отмечено в отчёте задачи как допущение.

import { analyticsDb } from '@/lib/db/clients';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { computeDelta } from '@/features/reports/engine/calculated';
import {
  ALL_TIME, buildAxisMap, salesPositiveIds, poolValuesForAxis,
  percentileScore, ratingFor, rawAxisValues, segmentToClientType, previousPeriod,
  fetchTouchSpeedByManager, resolveTemplateAxes, type CardSegment, type CategoryShare, type ManagerCardResult,
} from './managerCard';
import { getRawScoringWeights } from '@/lib/settings/scoringWeights';
import { getCardTemplate } from '@/lib/settings/cardTemplates';
import type { RosterManager } from '@/lib/org/teamRoster';
import { toSqlInterval, type DateRange } from '@/lib/period';
import type { ReportRow } from '@/lib/metrics/types';

// ── Сетка «Мой отдел» ─────────────────────────────────────────────────────────

export interface TeamRosterEntry {
  managerId: string;
  name: string;
  login: string | null;
  rating: number | null;
  /** До 6 значений 0-10 (уже с fallback на 0 для недоступных осей — как в ManagerCardRadar),
   *  порядок совпадает с осями шаблона 'manager' (card_templates, бриф 10.07) — тот
   *  же шаблон, что и большая карточка менеджера, поэтому мини-радар в сетке НИКОГДА
   *  не расходится по составу осей с ManagerCardPanel. Подписи не нужны — сетка
   *  рисует мини-радар без них. */
  radar: number[];
  salesAmount: number;
  /** Общий CR Сделка→Продажа (для бейджа «CR» под мини-радаром в бейдже сетки). */
  crOverall: number | null;
}

export interface TeamRosterResult {
  managers: TeamRosterEntry[];
  meta: { period: { from: string; to: string } };
}

export async function buildTeamRoster(opts: {
  roster: RosterManager[];
  period: DateRange;
  segment: CardSegment;
}): Promise<TeamRosterResult> {
  const clientType = segmentToClientType(opts.segment);

  const [periodPool, touchPeriodMap, rawWeights, template] = await Promise.all([
    fetchByManagers({ period: opts.period, dealScope: 'all', clientType, accountType: 'managers' }),
    fetchTouchSpeedByManager(opts.period),
    getRawScoringWeights(),
    getCardTemplate('manager'),
  ]);

  // Пул нормировки — ВСЯ компания (как в managerCard.ts), не только этот отдел.
  const axisMap  = buildAxisMap(periodPool, touchPeriodMap);
  const eligible = salesPositiveIds(periodPool);
  const rowById  = new Map(periodPool.map(r => [r.dimensionId, r]));
  const templateAxes = resolveTemplateAxes(template.axes);

  const managers: TeamRosterEntry[] = opts.roster.map(m => {
    const row = rowById.get(m.managerId);
    const rating = ratingFor(axisMap, eligible, m.managerId, rawWeights, templateAxes);
    const own = axisMap.get(m.managerId);
    const radar = templateAxes.map(def => {
      const raw = own?.[def.key] ?? null;
      if (raw === null) return 0;
      const pool = poolValuesForAxis(axisMap, eligible, def.key);
      return percentileScore(raw, pool, def.invert) ?? 0;
    });
    const dealsCount  = row?.metrics.deals_count ?? 0;
    const salesCount  = row?.metrics.sales_count ?? 0;
    const salesAmount = (row?.metrics.primary_sales_amount ?? 0) + (row?.metrics.repeat_sales_amount ?? 0);
    return {
      managerId: m.managerId, name: m.name, login: m.login,
      rating, radar, salesAmount,
      crOverall: dealsCount > 0 ? Math.round((salesCount / dealsCount) * 1000) / 10 : null,
    };
  }).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));

  return { managers, meta: { period: { from: opts.period.from.toISOString(), to: opts.period.to.toISOString() } } };
}

// ── Карточка отдела (агрегат) ────────────────────────────────────────────────

/** Синтетическая ReportRow-сумма компонентных метрик по набору менеджеров ("виртуальный менеджер"). */
function sumRows(pool: ReportRow[], managerIds: Set<string>): Record<string, number | null> {
  const keys = ['deals_count', 'reservations_count', 'confirmed_reservations_count', 'sales_count',
    'primary_sales_amount', 'repeat_sales_amount', 'shipments_count', 'lost_deals_count'];
  const out: Record<string, number> = Object.fromEntries(keys.map(k => [k, 0]));
  for (const row of pool) {
    if (!managerIds.has(row.dimensionId)) continue;
    for (const k of keys) out[k] += row.metrics[k] ?? 0;
  }
  return out;
}

function avgTouch(touchMap: Map<string, number> | null, managerIds: Set<string>): number | null {
  if (!touchMap) return null;
  const vals: number[] = [];
  for (const id of managerIds) {
    const v = touchMap.get(id);
    if (v !== undefined) vals.push(v);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function fetchCallsTizerForManagers(managerIdNums: number[], period: DateRange) {
  if (managerIdNums.length === 0) return { count: 0, avgDurationSec: null as number | null };
  try {
    const { from, toExcl } = toSqlInterval(period);
    const res = await analyticsDb().query<{ total: string; avg_duration: string | null }>(
      `SELECT count(*)::text AS total,
              avg(duration_seconds) FILTER (WHERE result = 'completed') AS avg_duration
       FROM va.calls
       WHERE manager_id = ANY($1) AND called_at >= $2 AND called_at < $3`,
      [managerIdNums, from, toExcl],
    );
    const row = res.rows[0];
    return {
      count: row ? Number(row.total) : 0,
      avgDurationSec: row?.avg_duration != null ? Number(row.avg_duration) : null,
    };
  } catch {
    return { count: 0, avgDurationSec: null };
  }
}

export interface DepartmentCardResult extends ManagerCardResult {
  deptComparison: { peerCount: number; insufficientPeers: boolean };
}

export async function buildDepartmentCard(opts: {
  deptId: string;
  deptName: string;
  branch: string | null;
  roster: RosterManager[];
  peerBuckets: Map<string, RosterManager[]>; // deptId → менеджеры (включая сам deptId), из bucketManagersByDepartments
  period: DateRange;
  segment: CardSegment;
}): Promise<DepartmentCardResult> {
  const clientType = segmentToClientType(opts.segment);
  const prevPeriod = previousPeriod(opts.period);
  const managerIds = new Set(opts.roster.map(m => m.managerId));
  const managerIdNums = opts.roster.map(m => Number(m.managerId)).filter(n => Number.isFinite(n));

  const [periodPool, prevPool, allTimePool, touchPeriodMap, touchAllTimeMap, rawWeights, template, callsTizer, pgRows] =
    await Promise.all([
      fetchByManagers({ period: opts.period, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchByManagers({ period: prevPeriod, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchByManagers({ period: ALL_TIME, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchTouchSpeedByManager(opts.period),
      fetchTouchSpeedByManager(ALL_TIME),
      getRawScoringWeights(),
      getCardTemplate('department'),
      fetchCallsTizerForManagers(managerIdNums, opts.period),
      // Топ-5 категорий отдела — ОДИН агрегатный запрос по всему ростеру, а не по
      // менеджеру (хотфикс 500 на «Дирекция», 20+ чел.: Promise.all по менеджеру бил
      // в пул analyticsDb max=5 connectionTimeoutMillis=5000, лишние запросы отваливались
      // по таймауту необработанным исключением). fetchByProductGroups фильтрует
      // d.current_manager_id IN (...) на уровне SQL — количество запросов не растёт
      // с размером отдела.
      opts.roster.length > 0
        ? fetchByProductGroups({
            period: opts.period, dealScope: 'all', clientType, productGroupMode: 'kc',
            managerIds: opts.roster.map(m => m.managerId),
          })
        : Promise.resolve([] as ReportRow[]),
    ]);

  // ── Синтетические «сырые» суммы отдела (текущий период / прошлый / всё время) ──
  const curSum = sumRows(periodPool, managerIds);
  const prevSum = sumRows(prevPool, managerIds);
  const allTimeSum = sumRows(allTimePool, managerIds);
  const touchCur = avgTouch(touchPeriodMap, managerIds);
  const touchAll = avgTouch(touchAllTimeMap, managerIds);

  const curAxisRaw     = rawAxisValues(curSum, touchCur);
  const allTimeAxisRaw = rawAxisValues(allTimeSum, touchAll);

  // ── Пиры: все department_id, назначенные хоть кому-то (+ корневые), включая нас ──
  // Строим axisMap+eligibility пиров для ЛЮБОГО пула (период / всё время) — общий
  // хелпер, чтобы не дублировать цикл по peerBuckets дважды (п.3 брифа: «всё время»
  // тоже должно быть посчитано, а не заглушкой — иначе серый слой паутины схлопывается
  // в точку, т.к. ManagerCardRadar трактует null как 0).
  function buildPeerAxisMap(pool: ReportRow[], touchMap: Map<string, number> | null, ownSum: Record<string, number | null>, ownTouch: number | null) {
    const sums = new Map<string, Record<string, number | null>>();
    for (const [deptId, members] of opts.peerBuckets) {
      sums.set(deptId, deptId === opts.deptId ? ownSum : sumRows(pool, new Set(members.map(m => m.managerId))));
    }
    const axisMap = new Map<string, ReturnType<typeof rawAxisValues>>();
    for (const [deptId, members] of opts.peerBuckets) {
      const touch = deptId === opts.deptId ? ownTouch : avgTouch(touchMap, new Set(members.map(m => m.managerId)));
      axisMap.set(deptId, rawAxisValues(sums.get(deptId)!, touch));
    }
    const eligible = new Set([...sums.entries()].filter(([, s]) => (s.sales_count ?? 0) > 0).map(([id]) => id));
    return { axisMap, eligible };
  }

  const peerIds = [...opts.peerBuckets.keys()];
  const insufficientPeers = peerIds.length < 2;
  const templateAxes = resolveTemplateAxes(template.axes);

  const { axisMap: deptAxisMap, eligible: deptEligible } = buildPeerAxisMap(periodPool, touchPeriodMap, curSum, touchCur);
  const rating = insufficientPeers ? null : ratingFor(deptAxisMap, deptEligible, opts.deptId, rawWeights, templateAxes);
  const orderedByRating = [...deptAxisMap.keys()]
    .map(id => ({ id, r: id === opts.deptId ? rating : (deptEligible.has(id) ? ratingFor(deptAxisMap, deptEligible, id, rawWeights, templateAxes) : null) }))
    .filter(x => x.r !== null)
    .sort((a, b) => b.r! - a.r!);
  const rank = insufficientPeers ? null : (orderedByRating.findIndex(x => x.id === opts.deptId) + 1 || null);

  const { axisMap: allTimeDeptAxisMap, eligible: allTimeDeptEligible } = insufficientPeers
    ? { axisMap: new Map(), eligible: new Set<string>() }
    : buildPeerAxisMap(allTimePool, touchAllTimeMap, allTimeSum, touchAll);

  const axes = templateAxes.map(def => ({
    key: def.key, label: def.label, unit: def.unit, invert: def.invert,
    period: {
      raw: curAxisRaw[def.key],
      normalized: insufficientPeers ? null : percentileScore(curAxisRaw[def.key], poolValuesForAxis(deptAxisMap, deptEligible, def.key), def.invert),
    },
    allTime: {
      raw: allTimeAxisRaw[def.key],
      normalized: insufficientPeers ? null : percentileScore(allTimeAxisRaw[def.key], poolValuesForAxis(allTimeDeptAxisMap, allTimeDeptEligible, def.key), def.invert),
    },
    dataAvailable: def.key === 'touch_speed' ? touchCur !== null : true,
  }));

  function tile(cur: number, prev: number) {
    return { current: cur, comparison: prev, ...computeDelta(cur, prev) };
  }
  const curSalesAmount  = (curSum.primary_sales_amount ?? 0) + (curSum.repeat_sales_amount ?? 0);
  const prevSalesAmount = (prevSum.primary_sales_amount ?? 0) + (prevSum.repeat_sales_amount ?? 0);
  const curSalesCount   = curSum.sales_count ?? 0;
  const prevSalesCount  = prevSum.sales_count ?? 0;

  const categoriesAgg = new Map<string, number>();
  for (const r of pgRows) {
    const amount = (r.metrics.primary_sales_amount ?? 0) + (r.metrics.repeat_sales_amount ?? 0);
    if (amount <= 0) continue;
    categoriesAgg.set(r.dimensionName, (categoriesAgg.get(r.dimensionName) ?? 0) + amount);
  }
  const categoriesAll = [...categoriesAgg.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  const totalCatAmount = categoriesAll.reduce((s, r) => s + r.amount, 0);
  const categories: CategoryShare[] = categoriesAll.slice(0, 5).map(r => ({
    name: r.name, amount: r.amount, share: totalCatAmount > 0 ? Math.round((r.amount / totalCatAmount) * 1000) / 10 : 0,
  }));

  return {
    profile: {
      managerId: `dept:${opts.deptId}`,
      name: `Отдел: ${opts.deptName}`,
      login: null,
      department: opts.deptName,
      branch: opts.branch,
    },
    rating: { value: rating, rank, deptSize: peerIds.length || 1 },
    radar: { axes },
    totals: {
      reservations:          tile(curSum.reservations_count ?? 0, prevSum.reservations_count ?? 0),
      confirmedReservations: tile(curSum.confirmed_reservations_count ?? 0, prevSum.confirmed_reservations_count ?? 0),
      salesCount:            tile(curSalesCount, prevSalesCount),
      salesAmount:           tile(curSalesAmount, prevSalesAmount),
      shipments:             tile(curSum.shipments_count ?? 0, prevSum.shipments_count ?? 0),
      avgCheck:              tile(curSalesCount > 0 ? curSalesAmount / curSalesCount : 0, prevSalesCount > 0 ? prevSalesAmount / prevSalesCount : 0),
    },
    categories,
    calls: { count: callsTizer.count, avgDurationSec: callsTizer.avgDurationSec, medianFirstTouchMinutes: touchCur },
    meta: {
      period: { from: opts.period.from.toISOString(), to: opts.period.to.toISOString() },
      comparisonPeriod: { from: prevPeriod.from.toISOString(), to: prevPeriod.to.toISOString() },
      touchSpeedAvailable: touchPeriodMap !== null,
    },
    visibleTiles: template.tiles,
    deptComparison: { peerCount: peerIds.length, insufficientPeers },
  };
}
