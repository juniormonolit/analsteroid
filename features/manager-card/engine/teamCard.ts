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
import { computeDelta, computeTotals } from '@/features/reports/engine/calculated';
import { enrichManagerRowsForMetrics } from '@/features/reports/engine/enrichManagerRows';
import { loadMetrics } from '@/lib/metrics/catalog';
import {
  buildAxisMap, salesPositiveIds, poolValuesForAxis,
  percentileScore, ratingFor, rawAxisValues, segmentToClientType, previousPeriod,
  fetchTouchSpeedByManager, resolveTemplateAxes, type CardSegment, type CategoryShare, type ManagerCardResult,
} from './managerCard';
import { getRawScoringWeights } from '@/lib/settings/scoringWeights';
import { getCardTemplate, type LegacyAxisKey } from '@/lib/settings/cardTemplates';
import type { RosterManager } from '@/lib/org/teamRoster';
import { toSqlInterval, type DateRange } from '@/lib/period';
import type { ReportRow, ProductGroupMode } from '@/lib/metrics/types';

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

  const [periodPoolRaw, touchPeriodMap, rawWeights, template, allMetrics] = await Promise.all([
    fetchByManagers({ period: opts.period, dealScope: 'all', clientType, accountType: 'managers' }),
    fetchTouchSpeedByManager(opts.period),
    getRawScoringWeights(),
    getCardTemplate('manager'),
    loadMetrics(),
  ]);

  // Задача 10.07, п.2: оси шаблона могут быть ЛЮБОЙ метрикой каталога, не только
  // legacy-8 — если шаблон 'manager' содержит catalog-оси, пул нужно обогатить ТЕМИ
  // ЖЕ функциями движка отчётов, что и managerCard.ts (реюз, не параллельный расчёт).
  // Каждая карточка сетки — ОДИН менеджер (не агрегат), поэтому здесь НЕТ проблемы
  // «медиана не аддитивна» из buildDepartmentCard ниже — просто читаем значение
  // конкретного менеджера из уже посчитанной ReportRow.metrics.
  const templateAxes = resolveTemplateAxes(template.axes, allMetrics);
  const catalogAxisKeys = [...new Set(templateAxes.filter(d => d.source === 'catalog').map(d => d.bareKey))];
  const periodPool = await enrichManagerRowsForMetrics(periodPoolRaw, opts.period, catalogAxisKeys);

  // Пул нормировки — ВСЯ компания (как в managerCard.ts), не только этот отдел.
  const axisMap  = buildAxisMap(periodPool, touchPeriodMap, templateAxes);
  const eligible = salesPositiveIds(periodPool);
  const rowById  = new Map(periodPool.map(r => [r.dimensionId, r]));

  const managers: TeamRosterEntry[] = opts.roster.map(m => {
    const row = rowById.get(m.managerId);
    const rating = ratingFor(axisMap, eligible, m.managerId, rawWeights, templateAxes);
    const own = axisMap.get(m.managerId);
    const radar = templateAxes.map(def => {
      const raw = own?.get(def.key) ?? null;
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
  /** Период сравнения (задача 10.07, п.3): явный, дефолт — previousPeriod(period). */
  comparisonPeriod?: DateRange;
  segment: CardSegment;
  /** Система товарных категорий (задача 10.07, п.4): дефолт 'kc' — прежнее поведение. */
  productGroupMode?: ProductGroupMode;
}): Promise<DepartmentCardResult> {
  const clientType = segmentToClientType(opts.segment);
  const prevPeriod = opts.comparisonPeriod ?? previousPeriod(opts.period);
  const productGroupMode: ProductGroupMode = opts.productGroupMode ?? 'kc';
  const managerIds = new Set(opts.roster.map(m => m.managerId));
  const managerIdNums = opts.roster.map(m => Number(m.managerId)).filter(n => Number.isFinite(n));

  const [periodPoolRaw, prevPoolRaw, touchPeriodMap, touchCompMap, rawWeights, template, callsTizer, pgRows, allMetrics] =
    await Promise.all([
      fetchByManagers({ period: opts.period, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchByManagers({ period: prevPeriod, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchTouchSpeedByManager(opts.period),
      fetchTouchSpeedByManager(prevPeriod),
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
            period: opts.period, dealScope: 'all', clientType, productGroupMode,
            managerIds: opts.roster.map(m => m.managerId),
          })
        : Promise.resolve([] as ReportRow[]),
      loadMetrics(),
    ]);

  // Задача 10.07, п.2: catalog-оси отдела обогащаются ТЕМИ ЖЕ функциями движка
  // отчётов (реюз, как и managerCard.ts/buildTeamRoster выше).
  const templateAxes = resolveTemplateAxes(template.axes, allMetrics);
  const catalogAxisKeys = [...new Set(templateAxes.filter(d => d.source === 'catalog').map(d => d.bareKey))];
  const [periodPool, prevPool] = await Promise.all([
    enrichManagerRowsForMetrics(periodPoolRaw, opts.period, catalogAxisKeys),
    enrichManagerRowsForMetrics(prevPoolRaw, prevPeriod, catalogAxisKeys),
  ]);

  // ── Синтетические «сырые» суммы отдела (текущий период / период сравнения) ──
  // Задача 10.07, п.3: полупрозрачный слой паутины теперь = период сравнения
  // (было «всё время», см. managerCard.ts::buildManagerCard — тот же приём).
  const curSum = sumRows(periodPool, managerIds);
  const prevSum = sumRows(prevPool, managerIds);
  const touchCur  = avgTouch(touchPeriodMap, managerIds);
  const touchComp = avgTouch(touchCompMap, managerIds);

  // Агрегат отдела для catalog-осей (задача 10.07, п.2): computeTotals() — тот же
  // приём, что «Итого» отчёта (calculated.ts) — сумма collected/external(sum) +
  // calculated ПЕРЕСЧИТАН из сумм. ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (см. отчёт задачи): для
  // внешних медианных метрик (aggregation_fn='none', calls_median_duration и т.п.)
  // computeTotals НЕ суммирует (медиана не аддитивна, как и «Итого» п.7) — их
  // агрегат на уровне ОТДЕЛА честно null. Карточка ОДНОГО менеджера и ФИФА-сетка
  // (buildTeamRoster выше) этого ограничения не имеют — там ось = значение
  // конкретного менеджера, не агрегат группы.
  function catalogAggregateFor(pool: ReportRow[], memberIds: Set<string>): Record<string, number | null> {
    if (catalogAxisKeys.length === 0) return {};
    return computeTotals(pool.filter(r => memberIds.has(r.dimensionId)), allMetrics);
  }

  function axisValuesFor(legacySum: Record<string, number | null>, touch: number | null, catalogAgg: Record<string, number | null>): Map<string, number | null> {
    const legacyVals = rawAxisValues(legacySum, touch);
    const out = new Map<string, number | null>();
    for (const def of templateAxes) {
      out.set(def.key, def.source === 'legacy' ? legacyVals[def.bareKey as LegacyAxisKey] : (catalogAgg[def.bareKey] ?? null));
    }
    return out;
  }

  const curCatalog  = catalogAggregateFor(periodPool, managerIds);
  const prevCatalog = catalogAggregateFor(prevPool, managerIds);
  const ownAxisMapCur  = axisValuesFor(curSum, touchCur, curCatalog);
  const ownAxisMapComp = axisValuesFor(prevSum, touchComp, prevCatalog);

  // ── Пиры: все department_id, назначенные хоть кому-то (+ корневые), включая нас ──
  // Строим axisMap+eligibility пиров для ЛЮБОГО пула (период / период сравнения) —
  // общий хелпер, чтобы не дублировать цикл по peerBuckets дважды (сравнение тоже
  // должно быть посчитано, а не заглушкой — иначе серый слой паутины схлопывается
  // в точку, т.к. ManagerCardRadar трактует null как 0).
  function buildPeerAxisMap(pool: ReportRow[], touchMap: Map<string, number> | null, ownAxisMap: Map<string, number | null>) {
    const axisMap = new Map<string, Map<string, number | null>>();
    const eligibleIds: string[] = [];
    for (const [deptId, members] of opts.peerBuckets) {
      const memberIds = new Set(members.map(m => m.managerId));
      if (deptId === opts.deptId) {
        axisMap.set(deptId, ownAxisMap);
      } else {
        const sum = sumRows(pool, memberIds);
        const touch = avgTouch(touchMap, memberIds);
        axisMap.set(deptId, axisValuesFor(sum, touch, catalogAggregateFor(pool, memberIds)));
      }
      const salesCount = deptId === opts.deptId ? (curSum.sales_count ?? 0) : sumRows(pool, memberIds).sales_count ?? 0;
      if (salesCount > 0) eligibleIds.push(deptId);
    }
    return { axisMap, eligible: new Set(eligibleIds) };
  }

  const peerIds = [...opts.peerBuckets.keys()];
  const insufficientPeers = peerIds.length < 2;

  const { axisMap: deptAxisMap, eligible: deptEligible } = buildPeerAxisMap(periodPool, touchPeriodMap, ownAxisMapCur);
  const rating = insufficientPeers ? null : ratingFor(deptAxisMap, deptEligible, opts.deptId, rawWeights, templateAxes);
  const orderedByRating = [...deptAxisMap.keys()]
    .map(id => ({ id, r: id === opts.deptId ? rating : (deptEligible.has(id) ? ratingFor(deptAxisMap, deptEligible, id, rawWeights, templateAxes) : null) }))
    .filter(x => x.r !== null)
    .sort((a, b) => b.r! - a.r!);
  const rank = insufficientPeers ? null : (orderedByRating.findIndex(x => x.id === opts.deptId) + 1 || null);

  const { axisMap: compDeptAxisMap, eligible: compDeptEligible } = insufficientPeers
    ? { axisMap: new Map(), eligible: new Set<string>() }
    : buildPeerAxisMap(prevPool, touchCompMap, ownAxisMapComp);

  const axes = templateAxes.map(def => ({
    key: def.key, label: def.label, unit: def.unit, invert: def.invert,
    period: {
      raw: ownAxisMapCur.get(def.key) ?? null,
      normalized: insufficientPeers ? null : percentileScore(ownAxisMapCur.get(def.key) ?? null, poolValuesForAxis(deptAxisMap, deptEligible, def.key), def.invert),
    },
    comparison: {
      raw: ownAxisMapComp.get(def.key) ?? null,
      normalized: insufficientPeers ? null : percentileScore(ownAxisMapComp.get(def.key) ?? null, poolValuesForAxis(compDeptAxisMap, compDeptEligible, def.key), def.invert),
    },
    dataAvailable: def.source === 'legacy' ? (def.bareKey === 'touch_speed' ? touchCur !== null : true) : true,
  }));

  function tile(cur: number, prev: number) {
    return { current: cur, comparison: prev, ...computeDelta(cur, prev) };
  }
  const curSalesAmount  = (curSum.primary_sales_amount ?? 0) + (curSum.repeat_sales_amount ?? 0);
  const prevSalesAmount = (prevSum.primary_sales_amount ?? 0) + (prevSum.repeat_sales_amount ?? 0);
  const curSalesCount   = curSum.sales_count ?? 0;
  const prevSalesCount  = prevSum.sales_count ?? 0;

  // pgRows уже сгруппирован по dimensionId (product_group_id/head_group_name) —
  // fetchByProductGroups с managerIds фильтрует SQL на роster ДО группировки, так что
  // здесь одна строка = одна категория, сумма УЖЕ по всем менеджерам отдела (доп.
  // ре-агрегация по имени была избыточна и теряла id, нужный дрилл-дауну п.5).
  const categoriesAll = pgRows
    .map(r => ({ id: r.dimensionId, name: r.dimensionName, amount: (r.metrics.primary_sales_amount ?? 0) + (r.metrics.repeat_sales_amount ?? 0) }))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const totalCatAmount = categoriesAll.reduce((s, r) => s + r.amount, 0);
  const categories: CategoryShare[] = categoriesAll.slice(0, 5).map(r => ({
    id: r.id, name: r.name, amount: r.amount, share: totalCatAmount > 0 ? Math.round((r.amount / totalCatAmount) * 1000) / 10 : 0,
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
