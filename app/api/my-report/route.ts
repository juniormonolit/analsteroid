// POST /api/my-report — данные для конструктора отчётов «Мой отчёт».
//
// Отдаёт НЕ готовый текст, а ReportSpec: структуру с числами, которую клиент
// сам прогоняет через движок (features/reports-builder/engine). Так сделано
// ради анимации сборки: цифры должны докручиваться от нуля к значению, а из
// готовой строки числа обратно не достать. Плюс движок один и тот же на сервере
// и на клиенте — расхождению взяться неоткуда.
//
// Устройство периода (решение владельца 06.08): блок «% ПЛАНА» ВСЕГДА показывает
// три окна — день, неделя, месяц («как идём по плану»), а остальные метрики
// считаются за один выбранный период («состояние на сегодня»). Так один-в-один
// воспроизводится ежедневный отчёт «МОСКВА».
//
// Источник — локальная БД, не Битрикс (спека: месячный выгруз портала слишком
// тяжёлый, чтобы дёргать его на каждое открытие раздела).

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { computeTotals } from '@/features/reports/engine/calculated';
import { EntityAccessError, resolveEntities, type EntityInput, type ResolvedEntity } from '@/lib/reports-builder/entities';
import { getMonthPlansByManager, getPlanWindows } from '@/lib/reports-builder/plans';
import { TOTAL, type ReportMetric, type ReportSpec } from '@/features/reports-builder/engine/buildReportText';
import type { MetricValue, ValueFormat } from '@/features/reports-builder/engine/format';
import type { Metric, ReportRow } from '@/lib/metrics/types';
import { toZonedTime } from 'date-fns-tz';

const TZ = 'Europe/Moscow';

type PeriodKey = 'day' | 'week' | 'month';
const PERIOD_TITLES: Record<PeriodKey, string> = { day: 'ДЕНЬ', week: 'НЕДЕЛЯ', month: 'МЕСЯЦ' };

// ── Даты (стенные часы МСК) ────────────────────────────────────────────────────────

function moscowTodayStr(): string {
  const now = toZonedTime(new Date(), TZ);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function windowStart(period: PeriodKey, dateStr: string): string {
  if (period === 'day') return dateStr;
  if (period === 'week') return mondayOf(dateStr);
  return `${dateStr.slice(0, 7)}-01`;
}

// ── Форматы метрик каталога → форматы движка ───────────────────────────────────────

/**
 * moneyFormat: отделы считают в миллионах (так во всех отчётах владельца), а
 * личный отчёт — по шкале млн/тыс/₽, иначе продажа на 60 тысяч выглядит как
 * «0,1 млн» и человек не видит своих денег.
 */
function metricFormat(m: Metric, moneyFormat: 'mln' | 'money'): ValueFormat {
  switch (m.dataType) {
    case 'money': return moneyFormat;
    case 'percent': return m.decimalPlaces === 0 ? 'pctv0' : 'pctv1';
    case 'int': return 'count';
    case 'months': return 'dec1';
    case 'decimal':
    default:
      if (m.decimalPlaces === 0) return 'count';
      return m.decimalPlaces === 1 ? 'dec1' : 'dec2';
  }
}

// ── Валидация ──────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ENTITIES = 12;
const MAX_METRICS = 60;

function parseEntities(raw: unknown): EntityInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ENTITIES) return null;
  const out: EntityInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const kind = (item as Record<string, unknown>).kind;
    const id = (item as Record<string, unknown>).id;
    if (kind === 'self') { out.push({ kind: 'self' }); continue; }
    if ((kind === 'department' || kind === 'branch') && typeof id === 'string' && id.length > 0 && id.length <= 200) {
      out.push({ kind, id });
      continue;
    }
    return null;
  }
  return out;
}

// ── Сборка ─────────────────────────────────────────────────────────────────────────

/** Значения одной метрики по всем сущностям + итог. */
function valuesFor(
  metricId: string,
  totalsByEntity: Map<string, Record<string, number | null>>,
  grandTotal: Record<string, number | null>,
): Record<string, MetricValue> {
  const values: Record<string, MetricValue> = { [TOTAL]: grandTotal[metricId] ?? null };
  for (const [key, totals] of totalsByEntity) values[key] = totals[metricId] ?? null;
  return values;
}

function planPercentMetric(
  period: PeriodKey,
  factByEntity: Map<string, number>,
  planByEntity: Map<string, number>,
): ReportMetric {
  const values: Record<string, MetricValue> = {};
  let factTotal = 0;
  let planTotal = 0;
  for (const [key, fact] of factByEntity) {
    const plan = planByEntity.get(key) ?? 0;
    values[key] = { num: fact, den: plan };
    factTotal += fact;
    planTotal += plan;
  }
  values[TOTAL] = { num: factTotal, den: planTotal };
  return { label: `% ПЛАНА (${PERIOD_TITLES[period]})`, format: 'pct0', values };
}

const SALES_AMOUNT_IDS = ['primary_sales_amount', 'repeat_sales_amount'];

function sumSalesByEntity(rows: ReportRow[], entities: ResolvedEntity[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entities) {
    let sum = 0;
    for (const row of rows) {
      if (!e.managerIds.has(row.dimensionId)) continue;
      for (const id of SALES_AMOUNT_IDS) sum += row.metrics[id] ?? 0;
    }
    out.set(e.key, sum);
  }
  return out;
}

function sumPlansByEntity(
  entities: ResolvedEntity[],
  plans: Map<string, { sales: number }>,
  fraction: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entities) {
    let sum = 0;
    for (const managerId of e.managerIds) sum += (plans.get(managerId)?.sales ?? 0) * fraction;
    out.set(e.key, sum);
  }
  return out;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const dateStr = typeof body.date === 'string' && DATE_RE.test(body.date) ? body.date : moscowTodayStr();
  const period: PeriodKey = body.period === 'day' || body.period === 'week' ? body.period : 'month';
  const entityInput = parseEntities(body.entities);
  if (!entityInput) {
    return NextResponse.json({ error: `entities: 1..${MAX_ENTITIES} сущностей вида {kind:"self"|"department"|"branch", id}` }, { status: 400 });
  }
  const metricIdsRaw = Array.isArray(body.metricIds) ? body.metricIds.filter((v): v is string => typeof v === 'string') : [];
  if (metricIdsRaw.length === 0 || metricIdsRaw.length > MAX_METRICS) {
    return NextResponse.json({ error: `metricIds: 1..${MAX_METRICS} идентификаторов метрик` }, { status: 400 });
  }

  let entities: ResolvedEntity[];
  try {
    entities = await resolveEntities(session, entityInput);
  } catch (err) {
    if (err instanceof EntityAccessError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }

  const allMetrics = await loadMetrics();
  const selected = resolveMetricIds(metricIdsRaw, allMetrics);
  if (selected.length === 0) {
    return NextResponse.json({ error: 'Ни одна из запрошенных метрик не найдена в каталоге' }, { status: 400 });
  }
  // Зависимости нужны, чтобы calculated-метрики (конверсии) было из чего считать,
  // но в отчёт они не попадают — только выбранные человеком.
  const withDeps = withDependencies(selected, allMetrics);

  const monthFirstDay = `${dateStr.slice(0, 7)}-01`;
  const weekStart = mondayOf(dateStr);
  // Даты — «стенные часы»: во всём приложении DateRange строится из msk()
  // (lib/period: toZonedTime + startOfDay в локальной зоне), и fetchByManagers
  // рассчитывает именно на такой Date. Парсим БЕЗ 'Z', иначе окно съедет.
  const to = new Date(`${dateStr}T23:59:59.999`);

  const fetchOpts = { dealScope: 'all' as const, clientType: 'all' as const, accountType: 'managers' as const };
  const windowRows = async (from: string) => fetchByManagers({
    period: { from: new Date(`${from}T00:00:00`), to },
    ...fetchOpts,
  });

  const [rowsDay, rowsWeek, rowsMonth, plans, planWindows] = await Promise.all([
    windowRows(dateStr),
    windowRows(weekStart),
    windowRows(monthFirstDay),
    getMonthPlansByManager(monthFirstDay),
    getPlanWindows(monthFirstDay, dateStr, weekStart),
  ]);

  const rowsByPeriod: Record<PeriodKey, ReportRow[]> = { day: rowsDay, week: rowsWeek, month: rowsMonth };

  // «% ПЛАНА» — три окна всегда.
  const planPct: ReportMetric[] = (['day', 'week', 'month'] as PeriodKey[]).map(p =>
    planPercentMetric(
      p,
      sumSalesByEntity(rowsByPeriod[p], entities),
      sumPlansByEntity(entities, plans, planWindows[p]),
    ),
  );

  // Остальные метрики — за выбранный период.
  const blockRows = rowsByPeriod[period];
  const totalsByEntity = new Map<string, Record<string, number | null>>();
  for (const e of entities) {
    totalsByEntity.set(e.key, computeTotals(blockRows.filter(r => e.managerIds.has(r.dimensionId)), withDeps));
  }
  const allSelectedManagers = new Set(entities.flatMap(e => [...e.managerIds]));
  const grandTotal = computeTotals(blockRows.filter(r => allSelectedManagers.has(r.dimensionId)), withDeps);

  const onlySelf = entities.length === 1 && entities[0].key === 'self';
  const moneyFormat = onlySelf ? 'money' : 'mln';
  const blockMetrics: ReportMetric[] = selected.map(m => ({
    label: m.nameShortRu || m.nameRu,
    format: metricFormat(m, moneyFormat),
    values: valuesFor(m.id, totalsByEntity, grandTotal),
  }));

  // Агрегат — везде, кроме личного отчёта из одной сущности (правило владельца).
  const aggregate = onlySelf
    ? undefined
    : { title: `ИТОГО (${entities.map(e => e.shortTitle).join('+')})` };

  const spec: ReportSpec = {
    title: onlySelf ? `Отчет: ${entities[0].title}` : `Отчет: ${entities.map(e => e.title).join(', ')}`,
    subtitle: { style: 'za', date: dateStr },
    entities: entities.map(e => ({ key: e.key, title: e.title })),
    overview: [planPct],
    entityBlock: blockMetrics,
    aggregate,
  };

  return NextResponse.json({ spec, meta: { date: dateStr, period } });
}
