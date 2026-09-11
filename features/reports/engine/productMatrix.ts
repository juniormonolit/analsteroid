import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { SERVICE_HEAD_GROUP_IDS, goodsPositionWhere } from '@/lib/metrics/serviceGroups';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType } from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';

// ── «Товарная матрица» (задача владельца 10.08.2026) ─────────────────────────
//
// Квадратная матрица «категория → категория»: в ячейке (A, B) — вероятность
// того, что СЛЕДУЮЩАЯ покупка клиента после заказа категории A будет из
// категории B. Диагональ — возврат в ту же категорию.
//
// ОПРЕДЕЛЕНИЯ:
//   * категория заказа — зависит от mode:
//       'by_max'    — ГЛАВНАЯ группа сделки (deals.head_group_name, «товары по
//                     наибольшему»): у заказа ровно одна категория;
//       'positions' — ВСЕ товарные группы позиций заказа (правка владельца 10.09:
//                     «а что если в одном чеке несколько категорий? каждую пару
//                     считать как кейс повторной продажи»). Заказ газобетона, за
//                     которым идёт заказ «утеплитель + ОСБ», даёт ДВА перехода:
//                     газобетон → утеплитель и газобетон → ОСБ. Сервисные позиции
//                     (перевозка и т.п.) категорией не считаются;
//   * переход — пара СОСЕДНИХ по времени отгрузок одного клиента (delivered_at,
//     при равенстве — deal_id). Сервисные сделки (главная группа — перевозка и
//     т.п.) из цепочки исключены ДО построения пар: «газобетон → доставка →
//     утеплитель» это переход газобетон → утеплитель;
//   * доля ячейки = переходы A→B ÷ ЧИСЛО ПОВТОРНЫХ ПОКУПОК ПОСЛЕ A (пар, где
//     предыдущий заказ содержал A). В 'by_max' у пары одна категория с каждой
//     стороны, поэтому строка суммируется ровно в 100 % — как было. В 'positions'
//     один следующий заказ может попасть в несколько колонок (в нём две категории),
//     и строка честно даёт БОЛЬШЕ 100 %: ячейка читается «в X % повторных покупок
//     после A брали B», а не «доля B среди всех купленных потом категорий» —
//     иначе кровля в чеке из трёх категорий выглядела бы втрое реже, чем есть;
//   * ПЕРИОД режет по ЗАКРЫВАЮЩЕЙ покупке пары — «куда вернулись те, кто
//     вернулся в периоде» (та же привязка, что у медианных времён раздела
//     «Клиенты»). Предыдущая покупка берётся из всей истории.
//
// Фильтр категорий — на КЛИЕНТЕ (UI режет видимые строки/колонки): вероятности
// считаются от ВСЕХ переходов, иначе скрытие колонки меняло бы числа в
// оставшихся, и матрица «врала» бы в зависимости от настроек просмотра.

export interface MatrixCell {
  from: string;
  to: string;
  n: number;
}

export interface ProductMatrixResult {
  /** Категории, встречающиеся в переходах периода (для строк/колонок и фильтра). */
  categories: string[];
  cells: MatrixCell[];
  /** Знаменатель строки: сколько повторных покупок было после этой категории. */
  rowTotals: Record<string, number>;
  /** Отгрузок категории в срезе — база конверсии в повтор (только anchor='first'). */
  shipments: Record<string, number>;
  /** Всего пар «покупка → следующая покупка» в срезе. */
  total: number;
  /** Всего отгрузок в срезе (только anchor='first'). */
  shipmentsTotal: number;
}

/** Чем считать категорию заказа — главной группой или всеми позициями (см. шапку). */
export type MatrixCategoryMode = 'by_max' | 'positions';

/**
 * Фильтры среза (задача владельца 10.09 — «матрица факта»: доля кровли после
 * газобетона в разрезе периода, отдела, менеджера). Все фильтры применяются к
 * ЗАКРЫВАЮЩЕЙ сделке пары — кто продал «следующее», тот и получает переход;
 * предыдущая покупка берётся из всей истории клиента без ограничений.
 */
export interface ProductMatrixOptions {
  period: DateRange;
  /** bitrix id менеджеров закрывающей сделки. */
  managerIds?: string[];
  /** bitrix_department_id — менеджеры этих отделов (как в остальных движках). */
  departmentIds?: string[];
  dealScope?: DealScope;
  clientType?: ClientType;
  /** По умолчанию 'by_max' — прежнее поведение «Товарной матрицы». */
  mode?: MatrixCategoryMode;
  /**
   * Что режет период и фильтры (правка владельца 10.09):
   *   'next'  — ЗАКРЫВАЮЩАЯ покупка пары (умолчание, прежняя «Товарная матрица»:
   *             «куда вернулись те, кто вернулся в периоде»);
   *   'first' — ИСХОДНАЯ отгрузка («Матрица переходов»): берём отгрузки категории
   *             за период и смотрим, чем клиент продолжил — тогда «120 отгрузок
   *             газобетона → 28 повторов → 23 %» это одна популяция, и конверсию
   *             можно писать в шапке строки.
   */
  periodAnchor?: 'next' | 'first';
}

const EXCLUDED_FUNNELS = '(4, 7)';

/** Общая часть SQL для матрицы и её дрилла: фильтры закрывающей сделки + CTE заказов. */
function buildMatrixScope(
  opts: ProductMatrixOptions, mode: MatrixCategoryMode, fromIso: string, toExclIso: string,
): { params: unknown[]; nextWhere: string; dealCats: string; anchorAt: string } {
  const params: unknown[] = [fromIso, toExclIso];
  const next: string[] = [];
  // Сторона пары, по которой режут период и фильтры (см. periodAnchor).
  const first = (opts.periodAnchor ?? 'next') === 'first';
  const mgrCol = first ? 'mgr' : 'next_mgr';
  const funnelCol = first ? 'funnel_id' : 'next_funnel';
  const anchorAt = first ? 'delivered_at' : 'next_at';
  const managerIds = (opts.managerIds ?? []).filter(id => /^\d+$/.test(id));
  if (managerIds.length) {
    params.push(managerIds);
    next.push(`${mgrCol} = ANY($${params.length}::text[])`);
  }
  const deptIds = (opts.departmentIds ?? []).filter(Boolean);
  if (deptIds.length) {
    params.push(deptIds);
    next.push(`${mgrCol} IN (
      SELECT manager_bitrix_user_id::text FROM sa.org_resolved_hierarchy orh
       WHERE orh.is_active AND orh.department_id IN (
         SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($${params.length}::text[])))`);
  }
  // Пилюли — по воронке закрывающей сделки (те же правила, что у отчётов).
  if (opts.dealScope === 'primary') next.push(`${funnelCol} IN (SELECT id FROM funnels WHERE is_repeat = false)`);
  else if (opts.dealScope === 'repeat') next.push(`${funnelCol} IN (SELECT id FROM funnels WHERE is_repeat = true)`);
  if (opts.clientType === 'b2c') next.push(`${funnelCol} IN (0, 2)`);
  else if (opts.clientType === 'b2b') next.push(`${funnelCol} IN (1, 3)`);

  // Заказ → массив его категорий. В 'by_max' массив из одного элемента, поэтому
  // дальше SQL общий для обоих режимов: пары строятся по ЗАКАЗАМ, а разворот в
  // категории — уже на паре (unnest × unnest).
  const dealCats = mode === 'positions'
    ? `
  SELECT d.contact_id, d.delivered_at, d.deal_id, d.deal_name, d.amount,
         d.current_manager_id::text AS mgr, d.funnel_id,
         array_agg(DISTINCT p->>'head_group_name') AS cats
    FROM sa.deals d, jsonb_array_elements(d.products) p
   WHERE d.delivered_at IS NOT NULL
     AND d.contact_id IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND ${goodsPositionWhere('p')}
     AND (p->>'head_group_name') IS NOT NULL
   GROUP BY d.contact_id, d.delivered_at, d.deal_id, d.deal_name, d.amount, d.current_manager_id, d.funnel_id`
    : `
  SELECT d.contact_id, d.delivered_at, d.deal_id, d.deal_name, d.amount,
         d.current_manager_id::text AS mgr, d.funnel_id,
         ARRAY[d.head_group_name] AS cats
    FROM sa.deals d
   WHERE d.delivered_at IS NOT NULL
     AND d.contact_id IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND d.head_group_name IS NOT NULL
     AND d.head_group_id NOT IN (${SERVICE_HEAD_GROUP_IDS.join(', ')})`;

  return { params, nextWhere: next.length ? `AND ${next.join(' AND ')}` : '', dealCats, anchorAt };
}

export async function fetchProductMatrix(input: DateRange | ProductMatrixOptions): Promise<ProductMatrixResult> {
  const opts: ProductMatrixOptions = 'period' in input ? input : { period: input };
  const mode: MatrixCategoryMode = opts.mode ?? 'by_max';
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const { params, nextWhere, dealCats, anchorAt } = buildMatrixScope(opts, mode, fromIso, toExclIso);

  const sql = `
WITH deal_cats AS (${dealCats}
),
seq AS (
  SELECT contact_id, cats, delivered_at, mgr, funnel_id,
         lead(cats)         OVER w AS next_cats,
         lead(delivered_at) OVER w AS next_at,
         lead(mgr)          OVER w AS next_mgr,
         lead(funnel_id)    OVER w AS next_funnel
    FROM deal_cats
  WINDOW w AS (PARTITION BY contact_id ORDER BY delivered_at, deal_id)
),
-- База среза: отгрузки (anchor='first') либо закрывающие покупки (anchor='next').
-- Для 'next' у строки всегда есть next_cats, поэтому base = pairs и «отгрузок»
-- в шапке строки нет — конверсия там неприменима.
base AS (
  SELECT * FROM seq
   WHERE ${anchorAt} >= $1 AND ${anchorAt} < $2
     ${nextWhere}
),
pairs AS (SELECT * FROM base WHERE next_cats IS NOT NULL)
SELECT 'cell' AS kind, f.cat AS from_grp, t.cat AS to_grp, count(*)::int AS n
  FROM pairs, unnest(cats) f(cat), unnest(next_cats) t(cat)
 GROUP BY 1, 2, 3
UNION ALL
-- Знаменатели строк: сколько ПАР было после каждой категории (одна пара — один
-- раз, даже если в следующем заказе несколько категорий).
SELECT 'row', f.cat, NULL, count(*)::int
  FROM pairs, unnest(cats) f(cat)
 GROUP BY 2
UNION ALL
-- База конверсии: все отгрузки категории в срезе, включая те, за которыми
-- продолжения не было.
SELECT 'ship', f.cat, NULL, count(*)::int
  FROM base, unnest(cats) f(cat)
 GROUP BY 2
UNION ALL
SELECT 'total', NULL, NULL, count(*)::int FROM pairs
UNION ALL
SELECT 'shipTotal', NULL, NULL, count(*)::int FROM base
`;

  const key = [
    mode, opts.periodAnchor ?? 'next', fromIso, toExclIso,
    (opts.managerIds ?? []).slice().sort().join(',') || 'm:all',
    (opts.departmentIds ?? []).slice().sort().join(',') || 'd:all',
    opts.dealScope ?? 'all', opts.clientType ?? 'all',
  ].join('|');
  const rows = await cached(
    `rpt:matrix3:${key}`,
    reportTtl(toExclIso),
    async () => {
      const res = await analyticsDb().query<{ kind: string; from_grp: string | null; to_grp: string | null; n: number }>(sql, params);
      return res.rows;
    },
  );

  const cells: MatrixCell[] = [];
  const rowTotals: Record<string, number> = {};
  const shipments: Record<string, number> = {};
  const cats = new Set<string>();
  let total = 0;
  let shipmentsTotal = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (r.kind === 'total') { total = n; continue; }
    if (r.kind === 'shipTotal') { shipmentsTotal = n; continue; }
    if (!r.from_grp) continue;
    cats.add(r.from_grp);
    if (r.kind === 'row') { rowTotals[r.from_grp] = n; continue; }
    if (r.kind === 'ship') { shipments[r.from_grp] = n; continue; }
    if (r.to_grp) { cells.push({ from: r.from_grp, to: r.to_grp, n }); cats.add(r.to_grp); }
  }
  // Порядок — по убыванию отгрузок категории (при равенстве — по повторам): сверху
  // и слева самые массовые категории, а не самые «конверсионные» из редких.
  const categories = [...cats].sort((a, b) =>
    (shipments[b] ?? rowTotals[b] ?? 0) - (shipments[a] ?? rowTotals[a] ?? 0)
    || (rowTotals[b] ?? 0) - (rowTotals[a] ?? 0));
  return { categories, cells, rowTotals, shipments, total, shipmentsTotal };
}


// ── Дрилл ячейки: кто продаёт связку и цепочки сделок (задача владельца 10.09) ──
//
// Клик по ячейке (A → B) отвечает на два вопроса владельца: «кто лучше продаёт
// кровлю после газобетона» (разбивка по менеджеру ЗАКРЫВАЮЩЕЙ сделки: сколько у
// него было повторных покупок после A и в скольких была B) и «покажи сами
// цепочки» (пары сделок: предыдущая → следующая). Знаменатель менеджера — его
// собственные повторные покупки после A, поэтому колонка «доля» сравнивает
// менеджеров честно, а не награждает того, у кого просто больше клиентов.

export interface TransitionManagerRow {
  managerId: string | null;
  name: string | null;
  /** Повторных покупок после A, закрытых этим менеджером. */
  afterFrom: number;
  /** Из них с категорией B. */
  n: number;
  /** Сумма закрывающих сделок связок A→B этого менеджера. */
  sumNext: number;
  /** Медиана дней между покупками в его связках. */
  medianDays: number | null;
}

/** Строка таба «материал → остальное»: чем продолжили после A (все категории). */
export interface TransitionNextGroup {
  cat: string;
  /** Повторных покупок после A, в которых была эта категория. */
  n: number;
  /** Заказчиков за этими покупками. */
  clients: number;
  /** Сумма закрывающих сделок (заказ из двух категорий попадает в обе строки). */
  sumNext: number;
  medianDays: number | null;
}

/** Агрегаты набора пар — для шапки дрилла. */
export interface TransitionAgg {
  /** Пар в наборе. */
  n: number;
  /** Уникальных заказчиков. */
  clients: number;
  /** Сумма исходных отгрузок пар. */
  sumPrev: number;
  /** Сумма закрывающих сделок пар. */
  sumNext: number;
  medianDays: number | null;
}

export interface TransitionDealBrief {
  dealId: number;
  name: string | null;
  at: string;
  amount: number;
  cats: string[];
}

export interface TransitionChain {
  prev: TransitionDealBrief;
  next: TransitionDealBrief;
  managerId: string | null;
  managerName: string | null;
  /** Дней между отгрузками пары. */
  days: number;
}

export interface MatrixTransitionsResult {
  managers: TransitionManagerRow[];
  chains: TransitionChain[];
  /** Всего переходов A → B в срезе. */
  total: number;
  /** Всего повторных покупок после A в срезе (знаменатель ячейки). */
  afterFrom: number;
  /** Показаны не все цепочки (потолок CHAINS_LIMIT). */
  truncated: boolean;
  /** Агрегаты связок A→B по всей ячейке (без фильтра менеджера). */
  hitsAgg: TransitionAgg;
  /** Агрегаты ВСЕХ повторных покупок после A — знаменатель ячейки. */
  afterFromAgg: TransitionAgg;
  /**
   * Таб «материал отгрузки → остальное» (правка владельца 11.09): чем вообще
   * продолжали после A, в разрезе товарной группы следующей покупки. Уважает
   * выбор менеджера в левой колонке — как и цепочки.
   */
  nextGroups: TransitionNextGroup[];
  /** Знаменатель разбивки: повторных покупок после A в текущем срезе дрилла. */
  nextGroupsBase: number;
}

export interface MatrixTransitionsOptions extends ProductMatrixOptions {
  /** Категория строки (что купили) и колонки (что купили следующим). */
  from: string;
  to: string;
  /** Показать цепочки только этого менеджера (клик по строке разбивки). */
  drillManagerId?: string;
}

const CHAINS_LIMIT = 300;

export async function fetchMatrixTransitions(opts: MatrixTransitionsOptions): Promise<MatrixTransitionsResult> {
  const mode: MatrixCategoryMode = opts.mode ?? 'by_max';
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();
  const { params, nextWhere, dealCats, anchorAt } = buildMatrixScope(opts, mode, fromIso, toExclIso);

  params.push(opts.from); const pFrom = `$${params.length}`;
  params.push(opts.to);   const pTo = `$${params.length}`;
  let drillWhere = '';
  if (opts.drillManagerId && /^\d+$/.test(opts.drillManagerId)) {
    params.push(opts.drillManagerId);
    // WHERE, а не AND: подзапрос цепочек ниже своего WHERE не имеет — с «AND»
    // получался синтаксически битый SQL и 500 при клике по менеджеру (10.09).
    drillWhere = `WHERE next_mgr = $${params.length}`;
  }

  // Колонки объединения (19): служебные агрегаты и цепочки в одном ответе —
  // deal_cats тяжёлый (jsonb_array_elements по всем отгрузкам), второй такой же
  // проход ради агрегатов удвоил бы время открытия дрилла.
  // АЛИАСЫ ОБЯЗАТЕЛЬНЫ: имена колонок ответа Postgres берёт из ПЕРВОЙ ветви
  // union, а первая здесь — 'mgr' с этими NULL-заглушками. Без AS колонки
  // приезжают безымянными (и с дублями вида «bigint»), node-pg кладёт их не под
  // теми ключами — цепочки приходили пустыми: «# —», 0 ₽, через 0 дн. (баг 11.09).
  const NULLS_DEAL = `NULL::bigint AS deal_id, NULL::text AS deal_name, NULL::timestamptz AS at,
       NULL::numeric AS amount, NULL::text[] AS cats,
       NULL::bigint AS next_deal_id, NULL::text AS next_deal_name, NULL::timestamptz AS next_at,
       NULL::numeric AS next_amount, NULL::text[] AS next_cats`;
  const DAYS = `EXTRACT(EPOCH FROM (next_at - delivered_at)) / 86400`;

  const sql = `
WITH deal_cats AS (${dealCats}
),
seq AS (
  SELECT contact_id, cats, deal_id, deal_name, amount, delivered_at, mgr, funnel_id,
         lead(cats)         OVER w AS next_cats,
         lead(delivered_at) OVER w AS next_at,
         lead(deal_id)      OVER w AS next_deal_id,
         lead(deal_name)    OVER w AS next_deal_name,
         lead(amount)       OVER w AS next_amount,
         lead(mgr)          OVER w AS next_mgr,
         lead(funnel_id)    OVER w AS next_funnel
    FROM deal_cats
  WINDOW w AS (PARTITION BY contact_id ORDER BY delivered_at, deal_id)
),
pairs AS (
  SELECT * FROM seq
   WHERE next_cats IS NOT NULL
     AND ${anchorAt} >= $1 AND ${anchorAt} < $2
     ${nextWhere}
),
after_from AS (SELECT * FROM pairs WHERE ${pFrom} = ANY(cats)),
hits AS (SELECT * FROM after_from WHERE ${pTo} = ANY(next_cats)),
-- Срез дрилла (выбранный менеджер) — для цепочек и разбивки «→ остальное».
af_drill AS (SELECT * FROM after_from ${drillWhere}),
hits_drill AS (SELECT * FROM hits ${drillWhere})
SELECT 'mgr' AS kind, next_mgr AS manager_id, NULL::text AS cat,
       count(*) FILTER (WHERE ${pTo} = ANY(next_cats))::int AS n,
       count(*)::int AS after_from,
       count(DISTINCT contact_id) FILTER (WHERE ${pTo} = ANY(next_cats))::int AS clients,
       NULL::numeric AS sum_prev,
       sum(next_amount) FILTER (WHERE ${pTo} = ANY(next_cats)) AS sum_next,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DAYS}) FILTER (WHERE ${pTo} = ANY(next_cats)) AS median_days,
       ${NULLS_DEAL}
  FROM after_from GROUP BY next_mgr
UNION ALL
-- Таб «материал → остальное»: чем продолжили после A, по группе следующей покупки.
-- Пара с двумя категориями в закрывающем заказе попадает в обе строки (как в ячейках матрицы).
SELECT 'grp', NULL, t.cat,
       count(*)::int, NULL::int, count(DISTINCT contact_id)::int,
       NULL::numeric, sum(next_amount),
       percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DAYS}),
       ${NULLS_DEAL}
  FROM af_drill, unnest(next_cats) t(cat) GROUP BY t.cat
UNION ALL
-- Знаменатель разбивки и её агрегаты (пары, а не категории — без двойного счёта).
SELECT 'grpBase', NULL, NULL,
       count(*)::int, NULL::int, count(DISTINCT contact_id)::int,
       sum(amount), sum(next_amount),
       percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DAYS}),
       ${NULLS_DEAL}
  FROM af_drill
UNION ALL
-- Агрегаты шапки — по СРЕЗУ ДРИЛЛА (правка владельца 11.09: «цифры пусть
-- пересчитываются исходя из выбранного слева менеджера»). Без выбора
-- hits_drill = hits, af_drill = after_from, то есть вся ячейка — как было.
-- Список менеджеров слева при этом остаётся глобальным (ветка 'mgr' выше):
-- иначе, выбрав одного, нельзя было бы вернуться к остальным.
SELECT 'hitsAgg', NULL, NULL,
       count(*)::int, NULL::int, count(DISTINCT contact_id)::int,
       sum(amount), sum(next_amount),
       percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DAYS}),
       ${NULLS_DEAL}
  FROM hits_drill
UNION ALL
SELECT 'afterFromAgg', NULL, NULL,
       count(*)::int, NULL::int, count(DISTINCT contact_id)::int,
       sum(amount), sum(next_amount),
       percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DAYS}),
       ${NULLS_DEAL}
  FROM af_drill
UNION ALL
SELECT 'chain', next_mgr, NULL,
       NULL::int, NULL::int, NULL::int, NULL::numeric, NULL::numeric, NULL::numeric,
       deal_id, deal_name, delivered_at, amount, cats,
       next_deal_id, next_deal_name, next_at, next_amount, next_cats
  FROM (SELECT * FROM hits_drill ORDER BY next_at DESC LIMIT ${CHAINS_LIMIT + 1}) c
`;

  type Row = {
    kind: 'mgr' | 'grp' | 'grpBase' | 'hitsAgg' | 'afterFromAgg' | 'chain';
    manager_id: string | null; cat: string | null;
    n: number | null; after_from: number | null; clients: number | null;
    sum_prev: string | null; sum_next: string | null; median_days: string | null;
    deal_id: string | null; deal_name: string | null; at: Date | null; amount: string | null; cats: string[] | null;
    next_deal_id: string | null; next_deal_name: string | null; next_at: Date | null; next_amount: string | null; next_cats: string[] | null;
  };
  // 'drill3' — версия формы ответа. Бампается при КАЖДОЙ смене набора колонок:
  // 'drill2' успел закэшировать битые строки (union без алиасов, см. NULLS_DEAL),
  // и без бампа они жили бы в Redis до истечения TTL уже после фикса.
  const key = [
    'drill3', mode, opts.periodAnchor ?? 'next', fromIso, toExclIso, opts.from, opts.to, opts.drillManagerId ?? '-',
    (opts.managerIds ?? []).slice().sort().join(',') || 'm:all',
    (opts.departmentIds ?? []).slice().sort().join(',') || 'd:all',
    opts.dealScope ?? 'all', opts.clientType ?? 'all',
  ].join('|');
  const rows = await cached(`rpt:matrix3:${key}`, reportTtl(toExclIso), async () => {
    const res = await analyticsDb().query<Row>(sql, params);
    return res.rows;
  });

  const managers: TransitionManagerRow[] = [];
  const chains: TransitionChain[] = [];
  const nextGroups: TransitionNextGroup[] = [];
  const emptyAgg = (): TransitionAgg => ({ n: 0, clients: 0, sumPrev: 0, sumNext: 0, medianDays: null });
  let hitsAgg = emptyAgg();
  let afterFromAgg = emptyAgg();
  let nextGroupsBase = 0;
  const num = (v: string | null) => (v === null ? 0 : Number(v));
  const med = (v: string | null) => (v === null ? null : Math.round(Number(v)));
  const aggOf = (r: Row): TransitionAgg => ({
    n: Number(r.n ?? 0), clients: Number(r.clients ?? 0),
    sumPrev: num(r.sum_prev), sumNext: num(r.sum_next), medianDays: med(r.median_days),
  });

  for (const r of rows) {
    if (r.kind === 'mgr') {
      managers.push({
        managerId: r.manager_id, name: null,
        afterFrom: Number(r.after_from ?? 0), n: Number(r.n ?? 0),
        sumNext: num(r.sum_next), medianDays: med(r.median_days),
      });
      continue;
    }
    if (r.kind === 'grp') {
      if (r.cat) nextGroups.push({
        cat: r.cat, n: Number(r.n ?? 0), clients: Number(r.clients ?? 0),
        sumNext: num(r.sum_next), medianDays: med(r.median_days),
      });
      continue;
    }
    if (r.kind === 'grpBase') { nextGroupsBase = Number(r.n ?? 0); continue; }
    if (r.kind === 'hitsAgg') { hitsAgg = aggOf(r); continue; }
    if (r.kind === 'afterFromAgg') { afterFromAgg = aggOf(r); continue; }
    const at = r.at ? new Date(r.at).toISOString() : '';
    const nextAt = r.next_at ? new Date(r.next_at).toISOString() : '';
    chains.push({
      prev: { dealId: Number(r.deal_id), name: r.deal_name, at, amount: Number(r.amount ?? 0), cats: r.cats ?? [] },
      next: { dealId: Number(r.next_deal_id), name: r.next_deal_name, at: nextAt, amount: Number(r.next_amount ?? 0), cats: r.next_cats ?? [] },
      managerId: r.manager_id,
      managerName: null,
      days: at && nextAt ? Math.round((new Date(nextAt).getTime() - new Date(at).getTime()) / 86_400_000) : 0,
    });
  }
  nextGroups.sort((a, b) => b.n - a.n || b.sumNext - a.sumNext);

  // Имена менеджеров — одним запросом по встретившимся id (в SQL выше JOIN дал бы
  // дубли строк оргструктуры).
  const ids = [...new Set([...managers, ...chains].map(x => x.managerId).filter((v): v is string => !!v))];
  if (ids.length) {
    const res = await analyticsDb().query<{ id: string; name: string }>(
      `SELECT DISTINCT ON (manager_bitrix_user_id) manager_bitrix_user_id::text AS id, manager_name AS name
         FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::text = ANY($1) AND is_active`,
      [ids],
    );
    const byId = new Map(res.rows.map(r => [r.id, r.name]));
    for (const m of managers) m.name = m.managerId ? byId.get(m.managerId) ?? null : null;
    for (const c of chains) c.managerName = c.managerId ? byId.get(c.managerId) ?? null : null;
  }

  // Лучшие — по числу связок; при равенстве выше тот, у кого выше доля.
  managers.sort((a, b) => b.n - a.n || (b.afterFrom ? b.n / b.afterFrom : 0) - (a.afterFrom ? a.n / a.afterFrom : 0));
  const truncated = chains.length > CHAINS_LIMIT;
  return {
    managers, chains: chains.slice(0, CHAINS_LIMIT),
    total: hitsAgg.n, afterFrom: afterFromAgg.n, truncated,
    hitsAgg, afterFromAgg, nextGroups, nextGroupsBase,
  };
}
