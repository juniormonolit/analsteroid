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
  /** Всего пар «покупка → следующая покупка» в срезе. */
  total: number;
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
}

const EXCLUDED_FUNNELS = '(4, 7)';

/** Общая часть SQL для матрицы и её дрилла: фильтры закрывающей сделки + CTE заказов. */
function buildMatrixScope(
  opts: ProductMatrixOptions, mode: MatrixCategoryMode, fromIso: string, toExclIso: string,
): { params: unknown[]; nextWhere: string; dealCats: string } {
  const params: unknown[] = [fromIso, toExclIso];
  const next: string[] = [];
  const managerIds = (opts.managerIds ?? []).filter(id => /^\d+$/.test(id));
  if (managerIds.length) {
    params.push(managerIds);
    next.push(`next_mgr = ANY($${params.length}::text[])`);
  }
  const deptIds = (opts.departmentIds ?? []).filter(Boolean);
  if (deptIds.length) {
    params.push(deptIds);
    next.push(`next_mgr IN (
      SELECT manager_bitrix_user_id::text FROM sa.org_resolved_hierarchy orh
       WHERE orh.is_active AND orh.department_id IN (
         SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($${params.length}::text[])))`);
  }
  // Пилюли — по воронке закрывающей сделки (те же правила, что у отчётов).
  if (opts.dealScope === 'primary') next.push(`next_funnel IN (SELECT id FROM funnels WHERE is_repeat = false)`);
  else if (opts.dealScope === 'repeat') next.push(`next_funnel IN (SELECT id FROM funnels WHERE is_repeat = true)`);
  if (opts.clientType === 'b2c') next.push(`next_funnel IN (0, 2)`);
  else if (opts.clientType === 'b2b') next.push(`next_funnel IN (1, 3)`);

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

  return { params, nextWhere: next.length ? `AND ${next.join(' AND ')}` : '', dealCats };
}

export async function fetchProductMatrix(input: DateRange | ProductMatrixOptions): Promise<ProductMatrixResult> {
  const opts: ProductMatrixOptions = 'period' in input ? input : { period: input };
  const mode: MatrixCategoryMode = opts.mode ?? 'by_max';
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const { params, nextWhere, dealCats } = buildMatrixScope(opts, mode, fromIso, toExclIso);

  const sql = `
WITH deal_cats AS (${dealCats}
),
seq AS (
  SELECT contact_id, cats,
         lead(cats)         OVER w AS next_cats,
         lead(delivered_at) OVER w AS next_at,
         lead(mgr)          OVER w AS next_mgr,
         lead(funnel_id)    OVER w AS next_funnel
    FROM deal_cats
  WINDOW w AS (PARTITION BY contact_id ORDER BY delivered_at, deal_id)
),
pairs AS (
  SELECT cats, next_cats FROM seq
   WHERE next_cats IS NOT NULL
     AND next_at >= $1 AND next_at < $2
     ${nextWhere}
)
SELECT f.cat AS from_grp, t.cat AS to_grp, count(*)::int AS n
  FROM pairs, unnest(cats) f(cat), unnest(next_cats) t(cat)
 GROUP BY 1, 2
UNION ALL
-- Знаменатели строк: сколько ПАР было после каждой категории (одна пара — один
-- раз, даже если в следующем заказе несколько категорий).
SELECT f.cat, NULL, count(*)::int
  FROM pairs, unnest(cats) f(cat)
 GROUP BY 1
UNION ALL
SELECT NULL, NULL, count(*)::int FROM pairs
`;

  const key = [
    mode, fromIso, toExclIso,
    (opts.managerIds ?? []).slice().sort().join(',') || 'm:all',
    (opts.departmentIds ?? []).slice().sort().join(',') || 'd:all',
    opts.dealScope ?? 'all', opts.clientType ?? 'all',
  ].join('|');
  const rows = await cached(
    `rpt:matrix3:${key}`,
    reportTtl(toExclIso),
    async () => {
      const res = await analyticsDb().query<{ from_grp: string | null; to_grp: string | null; n: number }>(sql, params);
      return res.rows;
    },
  );

  const cells: MatrixCell[] = [];
  const rowTotals: Record<string, number> = {};
  const cats = new Set<string>();
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (r.from_grp === null) { total = n; continue; }
    if (r.to_grp === null) { rowTotals[r.from_grp] = n; cats.add(r.from_grp); continue; }
    cells.push({ from: r.from_grp, to: r.to_grp, n });
    cats.add(r.from_grp);
    cats.add(r.to_grp);
  }
  // Порядок — по убыванию повторных покупок после категории: самые живые сверху/слева.
  const categories = [...cats].sort((a, b) => (rowTotals[b] ?? 0) - (rowTotals[a] ?? 0));
  return { categories, cells, rowTotals, total };
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
  const { params, nextWhere, dealCats } = buildMatrixScope(opts, mode, fromIso, toExclIso);

  params.push(opts.from); const pFrom = `$${params.length}`;
  params.push(opts.to);   const pTo = `$${params.length}`;
  let drillWhere = '';
  if (opts.drillManagerId && /^\d+$/.test(opts.drillManagerId)) {
    params.push(opts.drillManagerId);
    // WHERE, а не AND: подзапрос цепочек ниже своего WHERE не имеет — с «AND»
    // получался синтаксически битый SQL и 500 при клике по менеджеру (10.09).
    drillWhere = `WHERE next_mgr = $${params.length}`;
  }

  const sql = `
WITH deal_cats AS (${dealCats}
),
seq AS (
  SELECT contact_id, cats, deal_id, deal_name, amount, delivered_at,
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
     AND next_at >= $1 AND next_at < $2
     ${nextWhere}
),
after_from AS (SELECT * FROM pairs WHERE ${pFrom} = ANY(cats)),
hits AS (SELECT * FROM after_from WHERE ${pTo} = ANY(next_cats))
SELECT 'mgr' AS kind, next_mgr AS manager_id,
       count(*)::int AS after_from,
       count(*) FILTER (WHERE ${pTo} = ANY(next_cats))::int AS n,
       NULL::bigint AS deal_id, NULL::text AS deal_name, NULL::timestamptz AS at, NULL::numeric AS amount, NULL::text[] AS cats,
       NULL::bigint AS next_deal_id, NULL::text AS next_deal_name, NULL::timestamptz AS next_at, NULL::numeric AS next_amount, NULL::text[] AS next_cats
  FROM after_from GROUP BY next_mgr
UNION ALL
SELECT 'chain', next_mgr, NULL, NULL,
       deal_id, deal_name, delivered_at, amount, cats,
       next_deal_id, next_deal_name, next_at, next_amount, next_cats
  FROM (SELECT * FROM hits ${drillWhere} ORDER BY next_at DESC LIMIT ${CHAINS_LIMIT + 1}) c
`;

  type Row = {
    kind: 'mgr' | 'chain'; manager_id: string | null; after_from: number | null; n: number | null;
    deal_id: string | null; deal_name: string | null; at: Date | null; amount: string | null; cats: string[] | null;
    next_deal_id: string | null; next_deal_name: string | null; next_at: Date | null; next_amount: string | null; next_cats: string[] | null;
  };
  const key = [
    'drill', mode, fromIso, toExclIso, opts.from, opts.to, opts.drillManagerId ?? '-',
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
  let total = 0;
  let afterFrom = 0;
  for (const r of rows) {
    if (r.kind === 'mgr') {
      const n = Number(r.n ?? 0);
      const af = Number(r.after_from ?? 0);
      total += n;
      afterFrom += af;
      managers.push({ managerId: r.manager_id, name: null, afterFrom: af, n });
      continue;
    }
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
  return { managers, chains: chains.slice(0, CHAINS_LIMIT), total, afterFrom, truncated };
}
