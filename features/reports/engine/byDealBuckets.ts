import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { buildProductGroupFilter, productGroupCacheKey } from './productGroupFilter';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow, ProductGroupMode, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import { addDays, startOfDay } from 'date-fns';

// Измерение «Корзины по полю сделки» (задача владельца 18.08, вторая итерация:
// «я хочу задавать любую ось X»). Строка отчёта = корзина по выбранному ПОЛЮ
// СДЕЛКИ из реестра X_FIELDS ниже; внутри корзины работают ВСЕ метрики каталога
// и все фильтры — buildCollectedSQL с DimensionConfig, idExpr = CASE/выражение
// по полю. Начиналось как единственная ось «по сумме сделки» — обобщено в
// реестр: новая ось X = одна запись в X_FIELDS, без нового кода.
//
// ГРАНИЦА МЕХАНИКИ, которую стоит понимать: осью X может быть только свойство
// ОТДЕЛЬНОЙ сделки (сумма, час создания, день недели, месяц…) — по нему сделки
// раскладываются в корзины. Метрика-агрегат (CR, средний чек) осью X быть не
// может ни в каком конструкторе: это свойство группы, а не одной сделки.
//
// Смысловая оговорка про конверсии per-корзина: CR = «доля сделок этой корзины,
// созданных И проданных в выбранном периоде» — общая семантика CR-метрик
// каталога, корзины её наследуют. Для ВРЕМЕННЫХ осей (месяц/неделя создания)
// это даёт когортное чтение: сделка января, проданная в июле, попадает в
// корзину января со своей июльской продажей — «что стало с созданными тогда».
//
// Границы корзин чека — по фактическому распределению за 90 дней (замер 06.08:
// p25 ≈ 32,5 тыс, медиана ≈ 71 тыс, p75 ≈ 154 тыс, p90 ≈ 300 тыс).
// dimensionId — сортируемый ключ (номер корзины / '00'-'23' / ISO-дата):
// фронт сортирует по нему, а не по значению.
const AMOUNT_BUCKETS: { id: string; label: string; where: string }[] = [
  { id: '1', label: '0 ₽ / не указана',  where: `(d.amount IS NULL OR d.amount <= 0)` },
  { id: '2', label: 'до 50 тыс ₽',       where: `d.amount > 0 AND d.amount < 50000` },
  { id: '3', label: '50–100 тыс ₽',      where: `d.amount >= 50000 AND d.amount < 100000` },
  { id: '4', label: '100–300 тыс ₽',     where: `d.amount >= 100000 AND d.amount < 300000` },
  { id: '5', label: '300 тыс – 1 млн ₽', where: `d.amount >= 300000 AND d.amount < 1000000` },
  { id: '6', label: '1–3 млн ₽',         where: `d.amount >= 1000000 AND d.amount < 3000000` },
  { id: '7', label: '3 млн ₽ и выше',    where: `d.amount >= 3000000` },
];

const DOW_LABELS = ['', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MSK_TS = (col: string) => `(d.${col} AT TIME ZONE 'Europe/Moscow')`;

export interface XFieldDef {
  id: string;
  label: string;
  /** SQL-выражение сортируемого ключа корзины. */
  idExpr: string;
  /** id корзины → подпись. Не задан — подпись строит labelOf. */
  labelOf: (id: string) => string;
}

export const X_FIELDS: XFieldDef[] = [
  {
    id: 'amount', label: 'Сумма сделки',
    idExpr: `CASE\n  ${AMOUNT_BUCKETS.map(b => `WHEN ${b.where} THEN '${b.id}'`).join('\n  ')}\nEND`,
    labelOf: id => AMOUNT_BUCKETS.find(b => b.id === id)?.label ?? id,
  },
  {
    id: 'created_hour', label: 'Час создания сделки',
    idExpr: `to_char(${MSK_TS('created_at')}, 'HH24')`,
    labelOf: id => `${id}:00`,
  },
  {
    id: 'created_dow', label: 'День недели создания',
    idExpr: `to_char(${MSK_TS('created_at')}, 'ID')`,
    labelOf: id => DOW_LABELS[Number(id)] ?? id,
  },
  {
    id: 'created_week', label: 'Неделя создания',
    idExpr: `to_char(date_trunc('week', ${MSK_TS('created_at')}), 'YYYY-MM-DD')`,
    labelOf: id => `нед. ${id.slice(8, 10)}.${id.slice(5, 7)}`,
  },
  {
    id: 'created_month', label: 'Месяц создания',
    idExpr: `to_char(date_trunc('month', ${MSK_TS('created_at')}), 'YYYY-MM')`,
    labelOf: id => id,
  },
  {
    id: 'sold_month', label: 'Месяц продажи',
    idExpr: `CASE WHEN d.sold_at IS NOT NULL THEN to_char(date_trunc('month', ${MSK_TS('sold_at')}), 'YYYY-MM') END`,
    labelOf: id => id,
  },
];

const X_FIELD_BY_ID = new Map(X_FIELDS.map(f => [f.id, f]));

// ── Funnel metadata (тот же приём, что byProductGroups.ts) ────────────────────
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

type FlatRow = Record<string, unknown> & { dimension_id: string | null; funnel_id: number };

const _rowCache = new Map<string, { rows: FlatRow[]; at: number }>();
const ROW_TTL = 10 * 60 * 1000;

function computeAllowedFunnels(
  funnels: FunnelMeta[], dealScope: DealScope, clientType: ClientType,
): Set<number> | null {
  if (dealScope === 'all' && clientType === 'all') return null;
  return new Set<number>(funnels.filter(f => {
    const scopeOk = dealScope === 'all' || (dealScope === 'primary' ? !f.isRepeat : f.isRepeat);
    const clientOk = clientType === 'all' || (clientType === 'b2c' ? [0, 2].includes(f.id) : [1, 3].includes(f.id));
    return scopeOk && clientOk;
  }).map(f => f.id));
}

export interface ByDealBucketsOptions {
  /** id оси из X_FIELDS; неизвестный/пустой — 'amount' (обратная совместимость). */
  xField?: string;
  period: DateRange;
  dealScope?: DealScope;
  clientType?: ClientType;
  productGroupMode?: ProductGroupMode;
  productGroupIds?: string[];
  departmentIds?: string[];
  managerId?: string;
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  dealFilters?: DealFilter[];
}

export async function fetchByDealBuckets(opts: ByDealBucketsOptions): Promise<ReportRow[]> {
  const xf = X_FIELD_BY_ID.get(opts.xField ?? 'amount') ?? X_FIELD_BY_ID.get('amount')!;
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const mode       = opts.productGroupMode ?? 'kc';
  const deptIds    = opts.departmentIds ?? [];
  const managerId  = opts.managerId && /^\d+$/.test(opts.managerId) ? opts.managerId : undefined;
  const createdTimeFilter = opts.createdTimeFilter ?? 'all';
  const firstTouchFilter  = opts.firstTouchFilter  ?? 'all';

  const fromIso   = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  // Фильтр по отделам → allow-list менеджеров (та же логика и тот же источник
  // sa.org_resolved_hierarchy, что в byProductGroups.ts — НЕ YC-копия, задача 2065).
  let deptManagerWhere: string | undefined;
  const deptKey = deptIds.length ? [...deptIds].sort().join(',') : undefined;
  if (deptIds.length > 0) {
    const res = await analyticsDb().query<{ bitrix_user_id: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
         FROM sa.org_resolved_hierarchy orh
        WHERE orh.department_id IN (
          SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
        )
          AND orh.is_active = true`,
      [deptIds],
    );
    const ids = res.rows.map(r => r.bitrix_user_id).filter(id => /^\d+$/.test(id));
    deptManagerWhere = ids.length > 0 ? `d.current_manager_id IN (${ids.join(',')})` : '1=0';
  }

  const whereParts: string[] = [];
  if (managerId) whereParts.push(`d.current_manager_id = ${managerId}`);
  if (deptManagerWhere) whereParts.push(deptManagerWhere);
  const df = buildDealFilterWhere(opts.dealFilters);
  const offhWhereStr = [createdTimeWhere('d', createdTimeFilter), firstTouchWhere('d', firstTouchFilter), df.sql]
    .filter(Boolean).join(' AND ');
  if (offhWhereStr) whereParts.push(offhWhereStr);
  const offhKey = `${createdTimeFilter}:${firstTouchFilter}|df:${df.key}`;

  const pgFilterInput = { productGroupMode: mode, productGroupIds: opts.productGroupIds };
  const pgFilterMain = buildProductGroupFilter(pgFilterInput, 2); // после [fromIso, toExclIso]
  const pgKey = productGroupCacheKey(pgFilterInput);

  const whereMainParts = pgFilterMain ? [...whereParts, pgFilterMain.sql] : whereParts;
  const notNullWhere = whereMainParts.length > 0 ? whereMainParts.join(' AND ') : undefined;

  const allMetrics = await loadMetrics();
  const collected  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  const metricIds  = collected.map(m => m.id);
  const scopeIndependentIds = new Set(
    collected.filter(m => m.tags.includes('scope_independent')).map(m => m.id),
  );

  const dim = {
    idExpr:          xf.idExpr,
    // Подпись корзины строит labelOf по стабильному dimensionId; в SQL держим
    // только ключ, чтобы GROUP BY не таскал второе выражение.
    groupBy:         `GROUP BY ${xf.idExpr}, d.funnel_id`,
    notNullWhere,
    funnelBreakdown: true as const,
  };

  const key = `${xf.id}|${fromIso}|${toExclIso}|${pgKey}|${managerId ?? 'all'}|${deptKey ?? 'all'}|${offhKey}|${[...metricIds].sort().join(',')}`;
  let entry = _rowCache.get(key);
  if (!entry || Date.now() - entry.at > ROW_TTL) {
    const rows = await cached(`rpt:ab:${key}`, reportTtl(toExclIso), async () => {
      const sql = buildCollectedSQL(collected, dim);
      if (!sql) return [];
      const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso, ...(pgFilterMain?.params ?? [])]);
      return res.rows;
    });
    entry = { rows, at: Date.now() };
    _rowCache.set(key, entry);
  }

  // Пилюли — в памяти, как во всех измерениях (scope_independent-метрики не
  // режутся пилюлей первичных/повторных — тот же диагноз Маркуса, что в byManagers).
  const funnels = await loadFunnels();
  const allowed           = computeAllowedFunnels(funnels, dealScope, clientType);
  const allowedScopeIndep = scopeIndependentIds.size > 0 ? computeAllowedFunnels(funnels, 'all', clientType) : null;

  const agg = new Map<string, Record<string, number>>();
  for (const row of entry.rows) {
    const dimId = row.dimension_id;
    if (dimId === null || dimId === undefined) continue;
    const passesNormal     = allowed === null || allowed.has(row.funnel_id);
    const passesScopeIndep = allowedScopeIndep === null || allowedScopeIndep.has(row.funnel_id);
    if (!passesNormal && !passesScopeIndep) continue;
    if (!agg.has(dimId)) agg.set(dimId, Object.fromEntries(metricIds.map(id => [id, 0])));
    const entryM = agg.get(dimId)!;
    for (const id of metricIds) {
      const passes = scopeIndependentIds.has(id) ? passesScopeIndep : passesNormal;
      if (!passes) continue;
      const v = row[id];
      if (v !== null && v !== undefined) entryM[id] += Number(v);
    }
  }

  return [...agg.entries()]
    // Ключи корзин сортируемы строково ('1'..'7', '00'..'23', ISO-даты) —
    // localeCompare покрывает и числовые, и временные оси.
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, metrics]) => ({
      dimensionId:   id,
      dimensionName: xf.labelOf(id),
      teamId:        null,
      teamName:      null,
      metrics: Object.fromEntries(metricIds.map(mid => [mid, metrics[mid] !== undefined ? metrics[mid] : null])),
    }));
}
