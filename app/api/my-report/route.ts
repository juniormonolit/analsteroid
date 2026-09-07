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
import { enrichPlanMetrics } from '@/features/reports/engine/planMetrics';
import { EntityAccessError, resolveEntities, type EntityInput, type ResolvedEntity } from '@/lib/reports-builder/entities';
import { parseReportLabels, templateEntityKey } from '@/lib/reports-builder/presets';
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
// Блоки 3–4 отчёта (план/факт «на текущий день»): считаются всегда, независимо от выбора.
const FIXED_PLAN_METRIC_IDS = ['plan_sales_current_day', 'plan_shipments_current_day'];

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
  // но в отчёт они не попадают — только выбранные человеком. Плановые метрики
  // фиксированных блоков (3 и 4, правка владельца 07.09) добавляются всегда.
  const fixedPlanMetrics = resolveMetricIds(FIXED_PLAN_METRIC_IDS, allMetrics);
  const withDeps = withDependencies([...selected, ...fixedPlanMetrics], allMetrics);
  const labels = parseReportLabels(body);

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

  const [rowsDay, rowsWeek, rowsMonthRaw, plans, planWindows] = await Promise.all([
    windowRows(dateStr),
    windowRows(weekStart),
    windowRows(monthFirstDay),
    getMonthPlansByManager(monthFirstDay),
    getPlanWindows(monthFirstDay, dateStr, weekStart),
  ]);

  // Плановые метрики каталога («План продаж (на текущий день)» и т.п.) строки
  // fetchByManagers не содержат — их дорисовывает тот же движок, что и основной
  // отчёт (инцидент 07.09: без него планы в конструкторе были «0,0 млн»).
  // «Сегодня» для планов — дата отчёта: человек собирает «за 04.09» и ждёт план
  // на 04.09, а не на реальное сегодня.
  const enrich = async (rows: ReportRow[], fromStr: string): Promise<ReportRow[]> =>
    (await enrichPlanMetrics({
      withDeps,
      isManagersReport: true,
      mskTodayStr: dateStr,
      current: { rows, fromStr, toStr: dateStr },
      accountType: 'managers',
    })).current;
  const rowsMonth = await enrich(rowsMonthRaw, monthFirstDay);
  const rowsByPeriod: Record<PeriodKey, ReportRow[]> = { day: rowsDay, week: rowsWeek, month: rowsMonthRaw };
  const windowFromStr: Record<PeriodKey, string> = { day: dateStr, week: weekStart, month: monthFirstDay };

  // Подписи в отчёте: псевдонимы владельца поверх названий Монолитики.
  const inputKeys = entityInput.map(templateEntityKey);
  const display = entities.map((e, i) => {
    const a = labels.entityAliases?.[inputKeys[i] ?? ''];
    return { key: e.key, title: a?.name ?? e.title, short: a?.short ?? a?.name ?? e.shortTitle };
  });
  const titleOf = new Map(display.map(d => [d.key, d]));

  // Блок 1 — «% ПЛАНА»: три окна всегда.
  const planPct: ReportMetric[] = (['day', 'week', 'month'] as PeriodKey[]).map(p =>
    planPercentMetric(
      p,
      sumSalesByEntity(rowsByPeriod[p], entities),
      sumPlansByEntity(entities, plans, planWindows[p]),
    ),
  );

  const onlySelf = entities.length === 1 && entities[0].key === 'self';
  const moneyFormat = onlySelf ? 'money' : 'mln';
  const allSelectedManagers = new Set(entities.flatMap(e => [...e.managerIds]));
  const totalsOf = (rows: ReportRow[]) => {
    const byEntity = new Map<string, Record<string, number | null>>();
    for (const e of entities) byEntity.set(e.key, computeTotals(rows.filter(r => e.managerIds.has(r.dimensionId)), withDeps));
    const grand = computeTotals(rows.filter(r => allSelectedManagers.has(r.dimensionId)), withDeps);
    return { byEntity, grand };
  };

  // Блок 2 — выбранные показатели за выбранный период, каждый сводкой:
  // «[b]Метрика — итог[/b]» + строка на сущность (структура «МОСКВЫ»).
  const blockRows = period === 'month' ? rowsMonth : await enrich(rowsByPeriod[period], windowFromStr[period]);
  const periodTotals = totalsOf(blockRows);
  const selectedOverview: ReportMetric[] = selected.map(m => ({
    label: labels.metricAliases?.[m.id] ?? m.nameShortRu ?? m.nameRu,
    format: metricFormat(m, moneyFormat),
    values: valuesFor(m.id, periodTotals.byEntity, periodTotals.grand),
  }));

  // Блоки 3 и 4 — фиксированные план/факт по каждой сущности и ИТОГО, всегда с
  // начала месяца по дату отчёта («на текущий день»): план = дневной × рабочие дни
  // месяца до даты (plan_*_current_day), факт = все продажи/отгрузки (перв.+повт.).
  const monthTotals = totalsOf(rowsMonth);
  const planFactMetrics = ((): ReportMetric[] => {
    const cols: [string, Record<string, number | null>][] = [
      ...entities.map(e => [e.key, monthTotals.byEntity.get(e.key) ?? {}] as [string, Record<string, number | null>]),
      [TOTAL, monthTotals.grand],
    ];
    const g = (t: Record<string, number | null>, id: string) => t[id] ?? 0;
    const sales = (t: Record<string, number | null>) => g(t, 'primary_sales_amount') + g(t, 'repeat_sales_amount');
    const ships = (t: Record<string, number | null>) => g(t, 'primary_shipments_amount') + g(t, 'repeat_shipments_amount');
    const planS = (t: Record<string, number | null>) => t.plan_sales_current_day ?? null;
    const planSh = (t: Record<string, number | null>) => t.plan_shipments_current_day ?? null;
    const num = (f: (t: Record<string, number | null>) => number | null): Record<string, MetricValue> =>
      Object.fromEntries(cols.map(([k, t]) => [k, f(t)]));
    const ratio = (fact: (t: Record<string, number | null>) => number, plan: (t: Record<string, number | null>) => number | null): Record<string, MetricValue> =>
      Object.fromEntries(cols.map(([k, t]) => [k, { num: fact(t), den: plan(t) ?? 0 }]));
    return [
      { label: 'План продаж', format: moneyFormat, values: num(planS) },
      { label: 'Сумма продаж', format: moneyFormat, values: num(sales) },
      { label: '% выполнения', format: 'pct0', values: ratio(sales, planS) },
      { label: 'План отгрузок', format: moneyFormat, gapBefore: true, values: num(planSh) },
      { label: 'Сумма отгрузок', format: moneyFormat, values: num(ships) },
      { label: '% выполнения', format: 'pct0', values: ratio(ships, planSh) },
    ];
  })();

  const spec: ReportSpec = {
    title: labels.title ?? (onlySelf ? `Отчет: ${display[0]?.title ?? ''}` : `Отчет: ${display.map(d => d.title).join(', ')}`),
    subtitle: { style: 'za', date: dateStr },
    entities: display.map(d => ({ key: d.key, title: d.title, blockTitle: d.title.toUpperCase() })),
    overview: selectedOverview.length ? [planPct, selectedOverview] : [planPct],
    entityBlock: planFactMetrics,
    // Агрегат — везде, кроме личного отчёта из одной сущности (правило владельца).
    aggregate: onlySelf || labels.showTotal === false
      ? undefined
      : { title: `ИТОГО (${display.map(d => d.short).join('+')})`, metrics: planFactMetrics },
  };

  return NextResponse.json({ spec, meta: { date: dateStr, period } });
}
