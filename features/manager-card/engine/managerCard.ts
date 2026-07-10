import { analyticsDb, systemDb } from '@/lib/db/clients';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { computeDelta } from '@/features/reports/engine/calculated';
import { fetchTouchSpeedAllByManager } from '@/features/reports/engine/callsMetrics';
import { enrichManagerRowsForMetrics } from '@/features/reports/engine/enrichManagerRows';
import { loadMetrics } from '@/lib/metrics/catalog';
import { branchLabel } from '@/lib/org/branchLabel';
import { toSqlInterval, previousPeriodSameLength, type DateRange } from '@/lib/period';
import type { ClientType, ReportRow, ProductGroupMode, DataType } from '@/lib/metrics/types';
import { getRawScoringWeights, AXIS_KEYS as WEIGHTED_AXIS_KEYS, type AxisKey as WeightAxisKey } from '@/lib/settings/scoringWeights';
import {
  getCardTemplate, isLegacyStorageKey, stripLegacyPrefix, DEFAULT_AXES,
  isLegacyTileStorageKey, stripLegacyTilePrefix, DEFAULT_TILES,
  type AxisConfig, type LegacyAxisKey, type LegacyTileKey,
} from '@/lib/settings/cardTemplates';

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

// Период той же длины, непосредственно предшествующий текущему (для Δ%) — тонкий
// реэкспорт lib/period::previousPeriodSameLength (вынесена задачей 10.07, п.3,
// чтобы клиентский ManagerCardPanel.tsx мог посчитать ТОТ ЖЕ дефолт периода
// сравнения сам, не импортируя серверный движок с systemDb/analyticsDb).
export const previousPeriod = previousPeriodSameLength;

// ── Каталог осей паутины (задача 10.07, п.2: «из ВСЕХ метрик каталога») ─────────
// AxisDef.key — СЫРОЙ ключ хранения (card_templates.axes[].metricKey): «legacy:<8
// исходных ключей>» ИЛИ голый id ЛЮБОЙ метрики полного каталога (lib/metrics/
// catalog.ts::loadMetrics()). source различает, ЧЕМ считать значение оси:
//  - 'legacy'  → rawAxisValues() (бесплатные формулы из ReportRow.metrics collected-
//                полей, ноль новых запросов — так же, как v1/v2 до этой задачи);
//  - 'catalog' → просто row.metrics[bareKey] ПОСЛЕ enrichManagerRowsForMetrics()
//                (движок отчётов — реюз byManagers/managerActivity/callsMetrics/
//                stageConversions, см. features/reports/engine/enrichManagerRows.ts).
// invert теперь ВСЕГДА из шаблона (card_templates), а не хардкод здесь — админ
// может переключить «меньше — лучше» на любой оси (задача 10.07, п.2).
export type AxisUnit = 'percent' | 'money' | 'minutes' | 'count' | 'decimal';

export interface AxisDef {
  key: string;       // storage key (legacy:xxx или голый id каталога)
  bareKey: string;   // ключ БЕЗ префикса legacy: — то, чем реально индексируется значение
  label: string;
  unit: AxisUnit;
  invert: boolean;
  source: 'legacy' | 'catalog';
}

// Подписи/unit исходных 8 — короткие (для радара самой карточки; для страницы
// настроек — см. LEGACY_AXIS_LABELS в cardTemplates.ts, там подписи длиннее,
// disambiguated от одноимённых метрик каталога).
const LEGACY_AXIS_META: Record<LegacyAxisKey, { label: string; unit: AxisUnit }> = {
  cr_deal_to_reservation:      { label: 'CR Сделка → Бронь',        unit: 'percent' },
  cr_reservation_to_sale:      { label: 'CR Бронь → Продажа',       unit: 'percent' },
  sales_amount:                { label: 'Сумма продаж',             unit: 'money' },
  avg_check:                   { label: 'Средний чек',              unit: 'money' },
  touch_speed:                 { label: 'Скорость касания',         unit: 'minutes' },
  refusal_rate:                { label: 'Доля отказов',             unit: 'percent' },
  cr_reservation_to_confirmed: { label: 'CR Бронь → Подтверждена',  unit: 'percent' },
  shipment_rate:                { label: 'Доля отгруженного от проданного', unit: 'percent' },
};

function catalogUnitFor(dataType: DataType): AxisUnit {
  if (dataType === 'money') return 'money';
  if (dataType === 'percent') return 'percent';
  if (dataType === 'int') return 'count';
  return 'decimal'; // decimal/months
}

/** Дефолтные 6 осей (DEFAULT_AXES из cardTemplates.ts), уже резолвленные — чистая
 *  функция без БД, для фолбэка при пустом/битом шаблоне (не должно случаться —
 *  sanitizeAxes уже гарантирует дефолт на чтении, здесь доп. защита). */
export const DEFAULT_RESOLVED_AXES: AxisDef[] = DEFAULT_AXES.map(cfg => {
  const bare = stripLegacyPrefix(cfg.metricKey);
  const meta = LEGACY_AXIS_META[bare];
  return { key: cfg.metricKey, bareKey: bare, label: meta.label, unit: meta.unit, invert: cfg.invert, source: 'legacy' as const };
});

/** Оси шаблона (до 6, {metricKey, invert} из card_templates) → реальные AxisDef,
 *  в ТОМ ЖЕ порядке. allMetrics — живой каталог (loadMetrics()), нужен для
 *  label/unit catalog-осей. Неизвестные/удалённые из каталога id молча
 *  отбрасываются (как раньше); пустой результат — фолбэк на дефолтные 6. */
export function resolveTemplateAxes(axisConfigs: readonly AxisConfig[], allMetrics: { id: string; nameRu: string; dataType: DataType }[]): AxisDef[] {
  const metricById = new Map(allMetrics.map(m => [m.id, m]));
  const resolved: AxisDef[] = [];
  for (const cfg of axisConfigs) {
    if (isLegacyStorageKey(cfg.metricKey)) {
      const bare = stripLegacyPrefix(cfg.metricKey);
      const meta = LEGACY_AXIS_META[bare];
      if (!meta) continue;
      resolved.push({ key: cfg.metricKey, bareKey: bare, label: meta.label, unit: meta.unit, invert: cfg.invert, source: 'legacy' });
    } else {
      const m = metricById.get(cfg.metricKey);
      if (!m) continue;
      resolved.push({ key: cfg.metricKey, bareKey: cfg.metricKey, label: m.nameRu, unit: catalogUnitFor(m.dataType), invert: cfg.invert, source: 'catalog' });
    }
  }
  return resolved.length > 0 ? resolved : DEFAULT_RESOLVED_AXES;
}

/** Веса скоринга по оси: legacy-оси из ИСХОДНЫХ 6 (совпадающих со столбцами
 *  scoring_weights, миграция 068) — сырые 0-10 из lib/settings/scoringWeights.ts;
 *  ЛЮБАЯ другая ось (2 «бонусных» legacy + ЛЮБАЯ ось полного каталога) — вне
 *  таблицы весов, дефолт-вес 5 (эквивалент «важность как у остальных при равных
 *  весах»). ratingFor сам renормирует по сумме ФАКТИЧЕСКИ использованных осей
 *  (weightSum), поэтому именно СЫРАЯ (не нормированная на 1) шкала здесь корректна. */
function weightForAxis(raw: Partial<Record<WeightAxisKey, number>>, def: AxisDef): number {
  if (def.source === 'legacy' && (WEIGHTED_AXIS_KEYS as readonly string[]).includes(def.bareKey)) {
    const v = raw[def.bareKey as WeightAxisKey];
    return typeof v === 'number' ? v : 5;
  }
  return 5;
}

// Сырые значения ИСХОДНЫХ 8 legacy-осей по строке отчёта (fetchByManagers всегда
// отдаёт ВСЕ collected-метрики независимо от запроса — см. byManagers.ts). Не
// переименовано/не расширено этой задачей — единственный источник правды для
// legacy-осей, СОВПАДАЕТ буквально с поведением v1/v2 (инвариант «миграция не
// меняет цифр» из 073/075).
function rawLegacyAxisValues(metrics: Record<string, number | null>, touchMinutes: number | null): Record<LegacyAxisKey, number | null> {
  const dealsCount               = metrics.deals_count ?? 0;
  const reservationsCount        = metrics.reservations_count ?? 0;
  const confirmedReservationsCnt = metrics.confirmed_reservations_count ?? 0;
  const salesCount                = metrics.sales_count ?? 0;
  const salesAmount               = (metrics.primary_sales_amount ?? 0) + (metrics.repeat_sales_amount ?? 0);
  const lostCount                 = metrics.lost_deals_count ?? 0;
  const shipmentsCount            = metrics.shipments_count ?? 0;
  return {
    cr_deal_to_reservation:       dealsCount > 0 ? (reservationsCount / dealsCount) * 100 : null,
    cr_reservation_to_sale:       reservationsCount > 0 ? (salesCount / reservationsCount) * 100 : null,
    sales_amount:                 salesAmount,
    avg_check:                    salesCount > 0 ? salesAmount / salesCount : null,
    touch_speed:                  touchMinutes,
    refusal_rate:                 dealsCount > 0 ? (lostCount / dealsCount) * 100 : null,
    cr_reservation_to_confirmed:  reservationsCount > 0 ? (confirmedReservationsCnt / reservationsCount) * 100 : null,
    shipment_rate:                salesCount > 0 ? (shipmentsCount / salesCount) * 100 : null,
  };
}
// Публичный алиас — использовался teamCard.ts/managerCard.ts под этим именем до
// задачи 10.07 (оставлен для меньшего дифа/понятности вызывающего кода).
export const rawAxisValues = rawLegacyAxisValues;

export type AxisMap = Map<string, Map<string, number | null>>;

/** Строит по строке отчёта значения ВСЕХ переданных осей (и legacy, и catalog).
 *  Для catalog-осей ПРЕДПОЛАГАЕТСЯ, что `pool` уже прогнан через
 *  enrichManagerRowsForMetrics() для нужных bareKey (см. buildManagerCard/teamCard.ts) —
 *  buildAxisMap сам НЕ делает запросов к БД, только читает row.metrics. */
export function buildAxisMap(pool: ReportRow[], touchMap: Map<string, number> | null, axisDefs: readonly AxisDef[]): AxisMap {
  const m: AxisMap = new Map();
  for (const row of pool) {
    const touch = touchMap?.get(row.dimensionId) ?? null;
    const legacyVals = rawLegacyAxisValues(row.metrics, touch);
    const perAxis = new Map<string, number | null>();
    for (const def of axisDefs) {
      perAxis.set(def.key, def.source === 'legacy' ? legacyVals[def.bareKey as LegacyAxisKey] : (row.metrics[def.bareKey] ?? null));
    }
    m.set(row.dimensionId, perAxis);
  }
  return m;
}

// Пул нормировки (п.6 ТЗ): «ВСЕ менеджеры с продажами за тот же период».
export function salesPositiveIds(pool: ReportRow[]): Set<string> {
  return new Set(pool.filter(r => (r.metrics.sales_count ?? 0) > 0).map(r => r.dimensionId));
}

export function poolValuesForAxis(axisMap: AxisMap, eligibleIds: Set<string>, axisKey: string): number[] {
  const out: number[] = [];
  for (const id of eligibleIds) {
    const v = axisMap.get(id)?.get(axisKey);
    if (v !== null && v !== undefined) out.push(v);
  }
  return out;
}

// Перцентильная позиция значения в пуле → 0..10 (1 знак). Ничьи — средний ранг
// (полусумма «меньше»/«меньше-или-равно»). invert: для метрик «меньше — лучше»
// (скорость касания, доля отказов и т.п. — теперь настраивается на любой оси)
// переворачиваем шкалу.
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

// Рейтинг менеджера = взвешенное среднее нормированных (0-10) значений ДОСТУПНЫХ осей
// ШАБЛОНА карточки (до 6 из card_templates, см. resolveTemplateAxes; по умолчанию —
// исходные 6, поведение как в v1/v2 до появления шаблонов). Веса — сырые (0-10, НЕ
// нормированные на сумму=1): функция сама renормирует делением на weightSum
// ФАКТИЧЕСКИ использованных осей. Оси без данных (raw === null) исключаются из
// среднего (вес перенормируется на оставшиеся оси), а не считаются нулём — иначе
// отсутствие данных (напр. va.calls) необоснованно портило бы оценку. Если веса
// ВСЕХ фактически использованных осей — 0 (админ явно обнулил) — фолбэк на простое
// среднее (эквивалент равных долей, как было до весов), а не null.
export function ratingFor(
  axisMap: AxisMap,
  eligibleIds: Set<string>,
  managerId: string,
  rawWeights: Partial<Record<WeightAxisKey, number>>,
  axes: AxisDef[] = DEFAULT_RESOLVED_AXES,
): number | null {
  const own = axisMap.get(managerId);
  if (!own) return null;
  const weighted: { score: number; weight: number }[] = [];
  for (const def of axes) {
    const raw = own.get(def.key) ?? null;
    if (raw === null) continue;
    const pool = poolValuesForAxis(axisMap, eligibleIds, def.key);
    const score = percentileScore(raw, pool, def.invert);
    if (score !== null) weighted.push({ score, weight: weightForAxis(rawWeights, def) });
  }
  if (weighted.length === 0) return null;
  const weightSum = weighted.reduce((s, w) => s + w.weight, 0);
  const value = weightSum > 0
    ? weighted.reduce((s, w) => s + w.score * w.weight, 0) / weightSum
    : weighted.reduce((s, w) => s + w.score, 0) / weighted.length;
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

// ── Итоги периода (плитки) — задача 10.07 (карточка v4), п.1: «плитки из ВСЕХ
// метрик каталога», тот же приём, что оси паутины (resolveTemplateAxes выше):
// плитка — {key, bareKey, label, unit, source}, source различает ЧЕМ считать
// значение — 'legacy' (tileRaw(), 6 исходных бесплатных формул из ReportRow.metrics,
// ноль новых запросов — БЕЗ изменений в цифрах после наката 083) или 'catalog'
// (голое row.metrics[bareKey] ПОСЛЕ enrichManagerRowsForMetrics(), реюз того же
// enrich-вызова, что и catalog-оси — см. buildManagerCard/buildDepartmentCard,
// мёржат catalogAxisKeys+catalogTileKeys в ОДИН запрос обогащения). ────────────
interface TileMetricValue { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }

export interface TileDef {
  key: string;       // storage key (legacy:xxx или голый id каталога)
  bareKey: string;   // ключ БЕЗ префикса legacy: — то, чем реально индексируется значение
  label: string;
  unit: AxisUnit;
  source: 'legacy' | 'catalog';
}

export interface TileResult extends TileMetricValue {
  key: string;
  label: string;
  unit: AxisUnit;
}

const LEGACY_TILE_META: Record<LegacyTileKey, { label: string; unit: AxisUnit }> = {
  reservations:          { label: 'Брони',           unit: 'count' },
  confirmedReservations: { label: 'Подтв. брони',    unit: 'count' },
  salesCount:            { label: 'Продажи',         unit: 'count' },
  salesAmount:           { label: 'Сумма продаж',    unit: 'money' },
  shipments:             { label: 'Отгрузки',        unit: 'count' },
  avgCheck:              { label: 'Средний чек',     unit: 'money' },
};

/** Дефолтные 6 плиток (DEFAULT_TILES из cardTemplates.ts), уже резолвленные — чистая
 *  функция без БД, для фолбэка при пустом/битом шаблоне. */
export const DEFAULT_RESOLVED_TILES: TileDef[] = DEFAULT_TILES.map(key => {
  const bare = stripLegacyTilePrefix(key);
  const meta = LEGACY_TILE_META[bare];
  return { key, bareKey: bare, label: meta.label, unit: meta.unit, source: 'legacy' as const };
});

/** Плитки шаблона (произвольная длина, {tiles: string[]} из card_templates) →
 *  реальные TileDef, в ТОМ ЖЕ порядке. allMetrics — живой каталог (loadMetrics()),
 *  нужен для label/unit catalog-плиток. Неизвестные/удалённые из каталога id
 *  молча отбрасываются; пустой результат — фолбэк на дефолтные 6. */
export function resolveTemplateTiles(tileKeys: readonly string[], allMetrics: { id: string; nameRu: string; dataType: DataType }[]): TileDef[] {
  const metricById = new Map(allMetrics.map(m => [m.id, m]));
  const resolved: TileDef[] = [];
  for (const key of tileKeys) {
    if (isLegacyTileStorageKey(key)) {
      const bare = stripLegacyTilePrefix(key);
      const meta = LEGACY_TILE_META[bare];
      if (!meta) continue;
      resolved.push({ key, bareKey: bare, label: meta.label, unit: meta.unit, source: 'legacy' });
    } else {
      const m = metricById.get(key);
      if (!m) continue;
      resolved.push({ key, bareKey: key, label: m.nameRu, unit: catalogUnitFor(m.dataType), source: 'catalog' });
    }
  }
  return resolved.length > 0 ? resolved : DEFAULT_RESOLVED_TILES;
}

// Сырые значения ИСХОДНЫХ 6 legacy-плиток по метрикам строки отчёта (либо
// синтетической суммы отдела, см. teamCard.ts::buildDepartmentCard) — принимает
// ГОЛЫЕ metrics (не ReportRow), чтобы одинаково работать и для одного менеджера
// (row.metrics), и для агрегата отдела (sumRows()+catalogAggregateFor() merge).
function tileRaw(metrics: Record<string, number | null> | undefined) {
  const m = metrics ?? {};
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

/** Значение ОДНОЙ плитки по её определению — 'legacy' считает tileRaw() (6 бесплатных
 *  формул), 'catalog' — голое metrics[bareKey] (уже обогащено enrichManagerRowsForMetrics
 *  для catalog-плиток — см. вызовы buildManagerCard/buildDepartmentCard). */
export function tileRawValue(def: TileDef, metrics: Record<string, number | null> | undefined): number | null {
  if (def.source === 'legacy') return tileRaw(metrics)[def.bareKey as LegacyTileKey];
  return metrics?.[def.bareKey] ?? null;
}

/** Итоговый список плиток (значение+Δ% к периоду сравнения) по резолвленным
 *  TileDef — единственная точка сборки, переиспользуется buildManagerCard
 *  (per-manager metrics) и buildDepartmentCard (synthetic сумма отдела). */
export function buildTileResults(
  templateTiles: readonly TileDef[],
  currentMetrics: Record<string, number | null> | undefined,
  comparisonMetrics: Record<string, number | null> | undefined,
): TileResult[] {
  return templateTiles.map(def => {
    const current = tileRawValue(def, currentMetrics);
    const comparison = tileRawValue(def, comparisonMetrics);
    return { key: def.key, label: def.label, unit: def.unit, ...tileValue(current, comparison) };
  });
}

// ── Категории (топ-5 по доле суммы продаж) ───────────────────────────────────
// `id` — dimensionId из fetchByProductGroups (задача 10.07, п.4/5): для kc —
// numeric product_group_id (строкой) либо '__none__'; для by_max — САМО имя
// head_group_name (в этом режиме id и name совпадают, см. byProductGroups.ts).
// Нужен клиенту для дрилл-дауна «клик по группе → список сделок» (/api/reports/deals
// ?productGroup=<id>&productGroupMode=<mode>) — по одному только name kc-группу не
// восстановить однозначно (name — человекочитаемое, id — то, что реально в WHERE).
export interface CategoryShare { id: string; name: string; amount: number; share: number }

// ── Публичный контракт ───────────────────────────────────────────────────────
export interface ManagerCardOptions {
  managerId: string;
  period: DateRange;
  /** Период сравнения (задача 10.07, п.3 — «фильтры как в отчёте»): произвольный,
   *  явно задаваемый пользователем; дефолт (не передан) — previousPeriod(period),
   *  тот же период той же длины непосредственно перед текущим, что и раньше. */
  comparisonPeriod?: DateRange;
  segment: CardSegment;
  /** Система товарных категорий (задача 10.07, п.4): 'kc' — «Категория КЦ»
   *  (product_group_id, ~96), 'by_max' — «По наибольшему» (head_group_name, ~57).
   *  Дефолт 'kc' — прежнее поведение (было зашито жёстко). */
  productGroupMode?: ProductGroupMode;
}

export interface AxisResult {
  key: string;
  label: string;
  unit: AxisUnit;
  invert: boolean;
  period:  { raw: number | null; normalized: number | null };
  /** Полупрозрачный слой паутины (задача 10.07, п.3): период СРАВНЕНИЯ (тот же,
   *  что и колонка «к прошлому периоду» в итогах) — БЫЛО «всё время» (ALL_TIME),
   *  переименовано вслед за сменой семантики (владелец подтвердил: сравнение с
   *  прошлым периодом полезнее фиксированного «всё время» теперь, когда период
   *  сравнения сам настраивается). Имя поля переименовано (allTime → comparison)
   *  — обновить ВСЕХ потребителей (ManagerCardPanel.tsx/ManagerCardRadar.tsx). */
  comparison: { raw: number | null; normalized: number | null };
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
  /** Плитки итогов (задача 10.07 карточка v4, п.1) — набор И порядок из шаблона
   *  карточки (card_templates.tiles, произвольные метрики полного каталога, без
   *  ограничения количества); UI (ManagerCardPanel) рендерит ровно этот массив,
   *  без отдельного фильтра видимости — выбор в настройках УЖЕ и есть видимость. */
  tiles: TileResult[];
  categories: CategoryShare[];
  calls: (CallsTizer & { medianFirstTouchMinutes: number | null }) | null;
  meta: { period: { from: string; to: string }; comparisonPeriod: { from: string; to: string }; touchSpeedAvailable: boolean };
}

export async function buildManagerCard(opts: ManagerCardOptions): Promise<ManagerCardResult | { error: string }> {
  const { managerId, period, segment } = opts;
  const clientType = segmentToClientType(segment);
  // Период сравнения (задача 10.07, п.3): явный из настроек панели, дефолт — тот же
  // «предыдущий период той же длины», что и раньше (previousPeriod).
  const prevPeriod = opts.comparisonPeriod ?? previousPeriod(period);
  const productGroupMode: ProductGroupMode = opts.productGroupMode ?? 'kc';

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

  const [periodPoolRaw, prevPoolRaw, touchPeriodMap, touchCompMap, deptRosterRes, callsTizer, pgRows, rawWeights, template, allMetrics] =
    await Promise.all([
      fetchByManagers({ period, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchByManagers({ period: prevPeriod, dealScope: 'all', clientType, accountType: 'managers' }),
      fetchTouchSpeedByManager(period),
      fetchTouchSpeedByManager(prevPeriod),
      org.department_id
        ? sysDb.query<{ bitrix_user_id: string }>(
            `SELECT manager_bitrix_user_id::text AS bitrix_user_id
               FROM org_resolved_hierarchy WHERE department_id = $1 AND is_active = true`,
            [org.department_id],
          )
        : Promise.resolve({ rows: [{ bitrix_user_id: managerId }] }),
      managerIdNum !== null ? fetchCallsTizer(managerIdNum, period) : Promise.resolve(null),
      fetchByProductGroups({ period, dealScope: 'all', clientType, productGroupMode, managerId }),
      getRawScoringWeights(),
      getCardTemplate('manager'),
      loadMetrics(),
    ]);

  // ── Паутина: оси шаблона (до 6, задача 10.07 п.2 — из ВСЕХ метрик каталога),
  // период + период сравнения (п.3 — было «всё время», теперь полупрозрачный слой
  // = период сравнения, тот же, что и колонка «к прошлому периоду»), перцентильная
  // нормировка. Catalog-оси (НЕ legacy) требуют enrichManagerRowsForMetrics() —
  // реюз byManagers/managerActivity/callsMetrics/stageConversions (см. отчёт
  // задачи п.2) — ДЛЯ ОБОИХ пулов (период и сравнение), т.к. полупрозрачный слой
  // радара тоже читает эти же оси. Если шаблон — только legacy-оси (обычный
  // случай, дефолт), enrichManagerRowsForMetrics([]) — no-op, ноль лишних запросов. ─
  const templateAxes = resolveTemplateAxes(template.axes, allMetrics);
  const catalogAxisKeys = templateAxes.filter(d => d.source === 'catalog').map(d => d.bareKey);
  // Плитки итогов (задача 10.07 карточка v4, п.1 — «из ВСЕХ метрик каталога») —
  // catalog-плитки нуждаются в ТОМ ЖЕ обогащении, что и catalog-оси; мёржим оба
  // списка в ОДИН вызов enrichManagerRowsForMetrics (не два похода за одними и
  // теми же calls/activity/stage-conversion данными).
  const templateTiles = resolveTemplateTiles(template.tiles, allMetrics);
  const catalogTileKeys = templateTiles.filter(d => d.source === 'catalog').map(d => d.bareKey);
  const mergedCatalogKeys = [...new Set([...catalogAxisKeys, ...catalogTileKeys])];
  const [periodPool, prevPool] = await Promise.all([
    enrichManagerRowsForMetrics(periodPoolRaw, period, mergedCatalogKeys),
    enrichManagerRowsForMetrics(prevPoolRaw, prevPeriod, mergedCatalogKeys),
  ]);

  // currentRow/prevRow — ПОСЛЕ enrich (не periodPoolRaw/prevPoolRaw): catalog-
  // плитки читают bareKey из обогащённых metrics; legacy-плитки (tileRaw) читают
  // те же «сырые» поля, что были в *Raw-пуле — enrich мёржит их через {...row.metrics,
  // ...новые поля}, так что они остаются нетронутыми в periodPool/prevPool.
  const currentRow = periodPool.find(r => r.dimensionId === managerId);
  const prevRow    = prevPool.find(r => r.dimensionId === managerId);

  const periodAxisMap = buildAxisMap(periodPool, touchPeriodMap, templateAxes);
  const compAxisMap   = buildAxisMap(prevPool, touchCompMap, templateAxes);
  const periodEligible = salesPositiveIds(periodPool);
  const compEligible   = salesPositiveIds(prevPool);

  const axes: AxisResult[] = templateAxes.map(def => {
    const periodOwn = periodAxisMap.get(managerId)?.get(def.key) ?? null;
    const compOwn   = compAxisMap.get(managerId)?.get(def.key) ?? null;
    // dataAvailable: legacy touch_speed зависит от va.calls (проверено флагом
    // touchPeriodMap !== null, как раньше); остальные legacy — от sa.deals, всегда
    // доступны. Catalog-оси: источник (va.calls/deal_events) может быть недоступен
    // ЦЕЛИКОМ (период раньше начала сбора — см. CALLS_DATA_START/DEAL_EVENTS_DATA_START
    // в движке) — тогда ВСЕ строки пула получают null одинаково; эвристика «хотя бы
    // у одного менеджера есть значение» отличает «источник недоступен» от «честный
    // ноль/нет данных у ЭТОГО менеджера» (обычный случай — не пятнает asterisk).
    const dataAvailable = def.source === 'legacy'
      ? (def.bareKey === 'touch_speed' ? touchPeriodMap !== null : true)
      : periodPool.some(r => r.metrics[def.bareKey] !== null && r.metrics[def.bareKey] !== undefined);
    return {
      key: def.key, label: def.label, unit: def.unit, invert: def.invert,
      period: {
        raw: periodOwn,
        normalized: percentileScore(periodOwn, poolValuesForAxis(periodAxisMap, periodEligible, def.key), def.invert),
      },
      comparison: {
        raw: compOwn,
        normalized: percentileScore(compOwn, poolValuesForAxis(compAxisMap, compEligible, def.key), def.invert),
      },
      dataAvailable,
    };
  });

  // ── Рейтинг + ранг в отделе ─────────────────────────────────────────────────
  const rating = ratingFor(periodAxisMap, periodEligible, managerId, rawWeights, templateAxes);
  const deptMemberIds = deptRosterRes.rows.map(r => r.bitrix_user_id);
  const deptSize = deptMemberIds.length || 1;
  const deptRatings = deptMemberIds.map(id => ({
    id,
    rating: id === managerId ? rating : ratingFor(periodAxisMap, periodEligible, id, rawWeights, templateAxes),
  }));
  const withRating = deptRatings.filter(r => r.rating !== null).sort((a, b) => (b.rating! - a.rating!));
  const withoutRating = deptRatings.filter(r => r.rating === null);
  const orderedIds = [...withRating.map(r => r.id), ...withoutRating.map(r => r.id)];
  const rankIdx = orderedIds.indexOf(managerId);
  const rank = rankIdx >= 0 ? rankIdx + 1 : null;

  // ── Итоги периода (плитки) с Δ% к прошлому такому же периоду (задача 10.07
  // карточка v4, п.1 — произвольный набор плиток шаблона, не 6 зашитых) ───────
  const tiles = buildTileResults(templateTiles, currentRow?.metrics, prevRow?.metrics);

  // ── Топ-5 товарных категорий по доле суммы продаж ───────────────────────────
  const categoriesAll = pgRows
    .map(r => ({ id: r.dimensionId, name: r.dimensionName, amount: (r.metrics.primary_sales_amount ?? 0) + (r.metrics.repeat_sales_amount ?? 0) }))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const totalAmount = categoriesAll.reduce((s, r) => s + r.amount, 0);
  const categories: CategoryShare[] = categoriesAll.slice(0, 5).map(r => ({
    id: r.id, name: r.name, amount: r.amount, share: totalAmount > 0 ? Math.round((r.amount / totalAmount) * 1000) / 10 : 0,
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
    tiles,
    categories,
    calls: callsTizer ? { ...callsTizer, medianFirstTouchMinutes: touchPeriodOwn } : null,
    meta: {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      comparisonPeriod: { from: prevPeriod.from.toISOString(), to: prevPeriod.to.toISOString() },
      touchSpeedAvailable: touchPeriodMap !== null,
    },
  };
}
