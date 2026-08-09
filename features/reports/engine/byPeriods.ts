import { analyticsDb, systemDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { buildProductGroupFilter, productGroupCacheKey } from './productGroupFilter';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import { periodDateStrFromInstant, type DateRange, type CalendarUnit } from '@/lib/period';
import type {
  DealScope, ClientType, ReportRow, ProductGroupMode, AccountType,
  CreatedTimeFilter, FirstTouchFilter,
} from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';

// ── Отчёт «По периодам» (задача владельца 09.08) ─────────────────────────────
//
// Строки отчёта — не менеджеры и не товарные группы, а САМИ ПЕРИОДЫ: день/неделя/
// месяц/квартал/год внутри выбранного диапазона. Почему это отдельный движок, а не
// кнопка «сгруппировать по периодам» поверх byManagers:
//
//   byManagers/byProductGroups делают ОДИН SQL на все collected-метрики сразу —
//   измерение (менеджер, товарная группа) от даты не зависит, поэтому все метрики
//   влезают в один GROUP BY, каждая со своим `CASE WHEN d.<date_field> BETWEEN
//   $1 AND $2` внутри (см. sqlGen.buildCollectedSQL).
//
//   У периода измерение — `date_trunc(unit, d.<date_field>)`, а date_field у метрик
//   РАЗНЫЙ: sold_at, delivered_at, reserved_at, confirmed_at, created_at, lost_at.
//   Одну сделку нельзя положить в один бакет: её бронь в мае, продажа в июне,
//   отгрузка в июле. Значит — по запросу на каждый distinct date_field (сейчас их
//   шесть) и слияние результатов по ключу бакета.
//
// Тот же приём, что у графика метрики (metricSeries.ts — цикл по зависимостям),
// только там одна метрика, а здесь весь каталог. Формулы общие (buildCollectedSQL),
// параллельных определений нет: сумма бакетов обязана сходиться с ячейкой отчёта
// «по менеджерам» за тот же период.
//
// Поддержаны collected-метрики source='deals' (calculated считает вызывающий роут
// поверх их сумм). External (планы, звонки, стадии-снимки, медианы) — НЕ поддержаны:
// у каждой свой движок без универсальной разбивки по (период), а «Стадии (сейчас)»
// вообще период-независимы, в разрезе по времени они бессмысленны.

const MSK = 'Europe/Moscow';

/** Разрез, в который уходит дрилл-даун бакета. Определяет ОХВАТ сделок строки,
 *  чтобы «Итого» отчёта по периодам сходилось с тем отчётом, в который проваливаются:
 *   - managers: только сделки с менеджером (+ фильтр отдела/типа аккаунта) — как byManagers;
 *   - product-groups: все сделки среза — как byProductGroups (там менеджер не обязателен). */
export type PeriodsDimension = 'managers' | 'product-groups';

export interface ByPeriodsOptions {
  period: DateRange;
  unit: CalendarUnit;
  dimension: PeriodsDimension;
  dealScope?: DealScope;
  clientType?: ClientType;
  departmentIds?: string[];
  accountType?: AccountType;
  productGroupMode?: ProductGroupMode;
  productGroupIds?: string[];
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  dealFilters?: DealFilter[];
}

// ── Арифметика бакетов ───────────────────────────────────────────────────────
// Ключ бакета — МСК-календарная дата его НАЧАЛА в виде 'YYYY-MM-DD' (ровно то, что
// отдаёт SQL-выражение ниже). Вся арифметика — на UTC-датах этих строк: время суток
// в ключе не участвует, поэтому переходов через DST здесь нет по построению.

function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Начало бакета, которому принадлежит календарная дата. */
export function bucketStartOf(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  switch (unit) {
    case 'day':
      return ymd;
    case 'week': {
      const dow = (d.getUTCDay() + 6) % 7; // 0 = понедельник, как date_trunc('week') в PG
      d.setUTCDate(d.getUTCDate() - dow);
      return utcToYmd(d);
    }
    case 'month':
      return `${ymd.slice(0, 7)}-01`;
    case 'quarter': {
      const q = Math.floor(d.getUTCMonth() / 3) * 3;
      return `${d.getUTCFullYear()}-${String(q + 1).padStart(2, '0')}-01`;
    }
    case 'year':
      return `${ymd.slice(0, 4)}-01-01`;
  }
}

/** Следующий бакет (для непрерывной шкалы). */
export function nextBucket(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  switch (unit) {
    case 'day':     d.setUTCDate(d.getUTCDate() + 1); break;
    case 'week':    d.setUTCDate(d.getUTCDate() + 7); break;
    case 'month':   d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'quarter': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'year':    d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return utcToYmd(d);
}

/** Предыдущий бакет — база сравнения «к предыдущему периоду». */
export function prevBucket(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  switch (unit) {
    case 'day':     d.setUTCDate(d.getUTCDate() - 1); break;
    case 'week':    d.setUTCDate(d.getUTCDate() - 7); break;
    case 'month':   d.setUTCMonth(d.getUTCMonth() - 1); break;
    case 'quarter': d.setUTCMonth(d.getUTCMonth() - 3); break;
    case 'year':    d.setUTCFullYear(d.getUTCFullYear() - 1); break;
  }
  return utcToYmd(d);
}

/** Тот же бакет годом раньше — база сравнения «к прошлому году» (LFL).
 *
 *  Для дня/месяца/квартала/года — календарный сдвиг на год: «9 августа 2026» против
 *  «9 августа 2025», как человек и ожидает. Для НЕДЕЛИ календарный год не годится:
 *  «понедельник минус год» — это середина недели, такого бакета не существует.
 *  Поэтому неделя сдвигается на 52 недели (364 дня) — так сравниваются понедельник
 *  с понедельником, ровно как в рознице считают LFL. Расплата известна и осознанна:
 *  за 5–6 лет накапливается сдвиг в неделю относительно календаря. */
export function yoyBucket(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  if (unit === 'week') {
    d.setUTCDate(d.getUTCDate() - 364);
    return utcToYmd(d);
  }
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return bucketStartOf(utcToYmd(d), unit);
}

const MONTHS_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const WEEKDAYS_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const ROMAN_Q = ['I', 'II', 'III', 'IV'];

/** Номер ISO-недели (для подписи «нед. 32»). */
function isoWeekNumber(ymd: string): number {
  const d = ymdToUtc(ymd);
  // Четверг той же недели определяет её год и номер (ISO 8601).
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const jan4Thu = new Date(jan4);
  jan4Thu.setUTCDate(jan4.getUTCDate() + 3 - ((jan4.getUTCDay() + 6) % 7));
  return 1 + Math.round((d.getTime() - jan4Thu.getTime()) / (7 * 86_400_000));
}

const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

/** Человеческая подпись бакета (используется и в таблице, и в экспортах). */
export function bucketLabel(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  switch (unit) {
    case 'day':
      return `${dm(ymd)}.${ymd.slice(0, 4)}`;
    case 'week': {
      const end = ymdToUtc(nextBucket(ymd, 'week'));
      end.setUTCDate(end.getUTCDate() - 1);
      return `${dm(ymd)} – ${dm(utcToYmd(end))}.${end.getUTCFullYear()}`;
    }
    case 'month':
      return `${MONTHS_RU[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case 'quarter':
      return `${ROMAN_Q[Math.floor(d.getUTCMonth() / 3)]} кв. ${d.getUTCFullYear()}`;
    case 'year':
      return String(d.getUTCFullYear());
  }
}

/** Уточнение под подписью: день недели / номер недели / ничего. */
function bucketSubtitle(ymd: string, unit: CalendarUnit): string | undefined {
  if (unit === 'day') return WEEKDAYS_RU[(ymdToUtc(ymd).getUTCDay() + 6) % 7];
  if (unit === 'week') return `нед. ${isoWeekNumber(ymd)}`;
  return undefined;
}

// ── Кэш строк (как в byManagers/byProductGroups: L1 Map + L2 Redis) ──────────
type FlatRow = Record<string, unknown> & { dimension_id: string; funnel_id: number };

const _rowCache = new Map<string, { rows: FlatRow[]; at: number }>();
const ROW_TTL = 10 * 60 * 1000;

interface FunnelMeta { id: number; isRepeat: boolean }
let _funnels: FunnelMeta[] | null = null;
let _funnelsAt = 0;

async function loadFunnels(): Promise<FunnelMeta[]> {
  if (_funnels && Date.now() - _funnelsAt < 30 * 60 * 1000) return _funnels;
  const res = await analyticsDb().query<{ id: number; is_repeat: boolean }>(
    'SELECT id, is_repeat FROM funnels',
  );
  _funnels = res.rows.map(r => ({ id: r.id, isRepeat: r.is_repeat }));
  _funnelsAt = Date.now();
  return _funnels;
}

// Та же логика воронок, что в sqlGen/byManagers: primary/repeat ← funnels.is_repeat,
// b2c ← funnel_id IN (0,2), b2b ← funnel_id IN (1,3).
function computeAllowedFunnels(
  funnels: FunnelMeta[], dealScope: DealScope, clientType: ClientType,
): Set<number> | null {
  if (dealScope === 'all' && clientType === 'all') return null;
  return new Set<number>(
    funnels
      .filter(f => {
        const scopeOk = dealScope === 'all' || (dealScope === 'primary' ? !f.isRepeat : f.isRepeat);
        const clientOk = clientType === 'all'
          || (clientType === 'b2c' ? [0, 2].includes(f.id) : [1, 3].includes(f.id));
        return scopeOk && clientOk;
      })
      .map(f => f.id),
  );
}

/** Менеджеры, разрешённые фильтрами отчёта (отдел + тип аккаунта). null — без ограничения.
 *  В отличие от byManagers, где эти фильтры применяются К СТРОКАМ уже после агрегации
 *  (строка = менеджер), здесь строка — период, и отфильтровать постфактум нечего:
 *  ограничение обязано попасть в SQL WHERE до группировки по бакетам. */
async function resolveManagerScope(
  departmentIds: string[], accountType: AccountType,
): Promise<string[] | null> {
  const [deptRes, loginRes] = await Promise.all([
    departmentIds.length
      // Оргструктура — из sa, НЕ из YC system (синк Битрикса с 13.07 пишет только
      // туда; YC-копия протухла — задача 2065, тот же фикс, что в byManagers.ts).
      ? analyticsDb().query<{ bitrix_user_id: string }>(
          `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
             FROM sa.org_resolved_hierarchy orh
            WHERE orh.department_id IN (
              SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
            )
              AND orh.is_active = true`,
          [departmentIds],
        )
      : Promise.resolve(null),
    accountType !== 'all'
      // Тип аккаунта — по префиксу логина Битрикса (manager*/logist*), он живёт в
      // employees (system), а не в оргструктуре, где менеджеры — short_login #NNNN.
      ? systemDb().query<{ bitrix_user_id: string; bitrix_login: string | null }>(
          `SELECT bitrix_user_id::text AS bitrix_user_id, bitrix_login
             FROM employees WHERE is_active = true`,
        )
      : Promise.resolve(null),
  ]);

  let ids: string[] | null = deptRes
    ? deptRes.rows.map(r => r.bitrix_user_id).filter(id => /^\d+$/.test(id))
    : null;

  if (loginRes) {
    const prefix = accountType === 'managers' ? 'manager' : 'logist';
    const byType = loginRes.rows
      .filter(r => (r.bitrix_login ?? '').toLowerCase().startsWith(prefix))
      .map(r => r.bitrix_user_id)
      .filter(id => /^\d+$/.test(id));
    ids = ids === null ? byType : ids.filter(id => byType.includes(id));
  }
  return ids;
}

export interface PeriodBucketRow extends ReportRow {
  /** Ключ бакета (МСК-дата начала, 'YYYY-MM-DD') — он же dimensionId. */
  bucket: string;
}

/**
 * Значения всех collected-метрик по бакетам периода. Порядок — от НОВЫХ к СТАРЫМ
 * (решение владельца: свежее сверху). Пустые бакеты внутри диапазона возвращаются
 * нулями, а не пропусками: дыра в таблице читается как «данные не пришли», ноль —
 * как «продаж не было».
 */
export async function fetchByPeriods(opts: ByPeriodsOptions): Promise<PeriodBucketRow[]> {
  const dealScope = opts.dealScope ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const unit = opts.unit;
  const pgMode = opts.productGroupMode ?? 'kc';
  const createdTimeFilter = opts.createdTimeFilter ?? 'all';
  const firstTouchFilter = opts.firstTouchFilter ?? 'all';
  // Тип аккаунта имеет смысл только в менеджерском разрезе: у товарных групп
  // сделки без менеджера тоже считаются (как в byProductGroups).
  const accountType: AccountType = opts.dimension === 'managers' ? (opts.accountType ?? 'all') : 'all';

  // Границы окна — ровно как в byManagers/byProductGroups (from как есть,
  // toExcl = startOfDay(to)+1д), чтобы сумма бакетов сходилась с их ячейками.
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const managerScope = await resolveManagerScope(opts.departmentIds ?? [], accountType);

  const pgFilterInput = { productGroupMode: pgMode, productGroupIds: opts.productGroupIds };
  const pgFilter = buildProductGroupFilter(pgFilterInput, 3); // после [$1 from, $2 toExcl]
  const pgKey = productGroupCacheKey(pgFilterInput);

  const df = buildDealFilterWhere(opts.dealFilters);
  const offhWhere = [
    createdTimeWhere('d', createdTimeFilter),
    firstTouchWhere('d', firstTouchFilter),
    df.sql,
  ].filter(Boolean).join(' AND ');
  const offhKey = `${createdTimeFilter}:${firstTouchFilter}|df:${df.key}`;

  const whereParts: string[] = [];
  if (opts.dimension === 'managers') whereParts.push('d.current_manager_id IS NOT NULL');
  if (managerScope !== null) {
    // Пустой список — отдел/тип без единого менеджера: честный «ничего», а не
    // молча проигнорированный фильтр (тот же приём, что в byProductGroups).
    whereParts.push(managerScope.length ? `d.current_manager_id IN (${managerScope.join(',')})` : '1=0');
  }
  if (pgFilter) whereParts.push(pgFilter.sql);
  if (offhWhere) whereParts.push(offhWhere);
  const notNullWhere = whereParts.length ? whereParts.join(' AND ') : undefined;

  const allMetrics = await loadMetrics();
  // source='deals' — единственный источник с универсальной разбивкой по времени
  // (граница ровно та же, что у графика метрики, см. collectible() в metricSeries.ts).
  const collected = allMetrics.filter(
    m => m.metricType === 'collected' && !m.isTest
      && m.source === 'deals' && m.aggFn && m.aggField && m.dateField,
  );
  const metricIds = collected.map(m => m.id);
  const scopeIndependentIds = new Set(
    collected.filter(m => m.tags.includes('scope_independent')).map(m => m.id),
  );

  // Ключевое место движка: по запросу на КАЖДОЕ date_field. Метрики с одинаковым
  // date_field делят один SQL — их можно бакетировать одним и тем же date_trunc.
  const byDateField = new Map<string, typeof collected>();
  for (const m of collected) {
    const f = m.dateField!;
    if (!byDateField.has(f)) byDateField.set(f, []);
    byDateField.get(f)!.push(m);
  }

  const scopeKey = [
    opts.dimension,
    managerScope === null ? 'all' : managerScope.join(','),
    pgKey, offhKey,
  ].join('|');

  const funnels = await loadFunnels();
  const allowed = computeAllowedFunnels(funnels, dealScope, clientType);
  const allowedScopeIndep = scopeIndependentIds.size > 0
    ? computeAllowedFunnels(funnels, 'all', clientType)
    : null;

  // sums[bucket][metricId]
  const sums = new Map<string, Record<string, number>>();

  await Promise.all([...byDateField.entries()].map(async ([dateField, group]) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(dateField)) return; // date_field из каталога — не из запроса, но проверяем
    const dim = {
      idExpr: `to_char(date_trunc('${unit}', (d.${dateField} AT TIME ZONE '${MSK}')), 'YYYY-MM-DD')`,
      groupBy: 'GROUP BY 1, d.funnel_id',
      notNullWhere,
      funnelBreakdown: true as const,
    };
    const sql = buildCollectedSQL(group, dim);
    if (!sql) return;

    const key = `${fromIso}|${toExclIso}|${unit}|${dateField}|${scopeKey}|${group.map(m => m.id).sort().join(',')}`;
    let entry = _rowCache.get(key);
    if (!entry || Date.now() - entry.at > ROW_TTL) {
      const rows = await cached(`rpt:per:${key}`, reportTtl(toExclIso), async () => {
        const res = await analyticsDb().query<FlatRow>(
          sql, [fromIso, toExclIso, ...(pgFilter?.params ?? [])],
        );
        return res.rows;
      });
      entry = { rows, at: Date.now() };
      _rowCache.set(key, entry);
    }

    // Пилюли Первичные/Повторные/Б2Б/Б2С — постфактум по funnel_id, как в остальных
    // движках (кэш строк от пилюль не зависит, поэтому переключение мгновенное).
    for (const row of entry.rows) {
      const passesNormal = allowed === null || allowed.has(row.funnel_id);
      const passesScopeIndep = allowedScopeIndep === null || allowedScopeIndep.has(row.funnel_id);
      if (!passesNormal && !passesScopeIndep) continue;
      const b = row.dimension_id;
      if (!b) continue;
      let entryB = sums.get(b);
      if (!entryB) { entryB = {}; sums.set(b, entryB); }
      for (const m of group) {
        const passes = scopeIndependentIds.has(m.id) ? passesScopeIndep : passesNormal;
        if (!passes) continue;
        const v = row[m.id];
        if (v === null || v === undefined) continue;
        entryB[m.id] = (entryB[m.id] ?? 0) + Number(v);
      }
    }
  }));

  // Непрерывная шкала бакетов окна. Крайние бакеты могут быть НЕПОЛНЫМИ (период
  // начался/кончился в середине месяца) — помечаем подписью, иначе «август просел»
  // читается как падение продаж, а не как обрезанный период.
  const fromYmd = periodDateStrFromInstant(opts.period.from, 'from');
  const toYmd = periodDateStrFromInstant(opts.period.to, 'to');
  const firstBucket = bucketStartOf(fromYmd, unit);
  const lastBucket = bucketStartOf(toYmd, unit);

  const out: PeriodBucketRow[] = [];
  for (let b = firstBucket; b <= lastBucket; b = nextBucket(b, unit)) {
    const metrics = sums.get(b) ?? {};
    const partial = (b === firstBucket && b !== fromYmd)
      || (b === lastBucket && nextBucket(b, unit) !== nextBucket(toYmd, 'day'));
    const sub = [bucketSubtitle(b, unit), partial ? 'неполный' : null].filter(Boolean).join(' · ');
    out.push({
      bucket: b,
      dimensionId: b,
      dimensionName: bucketLabel(b, unit),
      dimensionSubtitle: sub || undefined,
      teamId: null,
      teamName: null,
      metrics: Object.fromEntries(metricIds.map(id => [id, metrics[id] ?? 0])),
    });
    if (out.length > 1000) break; // страховка от бесконечного цикла; реальный кап — в роуте
  }

  // От новых к старым (решение владельца 09.08: «новые вверху короче»).
  return out.reverse();
}
