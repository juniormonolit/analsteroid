import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { SERVICE_HEAD_GROUP_IDS } from '@/lib/metrics/serviceGroups';
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
//   * категория заказа — ГЛАВНАЯ группа сделки («товары по наибольшему», как
//     назвал владелец, — deals.head_group_name, шкала by_max);
//   * переход — пара СОСЕДНИХ по времени отгрузок одного клиента (delivered_at,
//     при равенстве — deal_id). Сервисные сделки (главная группа — перевозка и
//     т.п.) из цепочки исключены ДО построения пар: «газобетон → доставка →
//     утеплитель» это переход газобетон → утеплитель;
//   * вероятность ячейки = переходы A→B / все переходы из A (строка в сумме
//     даёт 100 %);
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
  /** Всего переходов из категории (знаменатель строки). */
  rowTotals: Record<string, number>;
  /** Всего переходов в срезе. */
  total: number;
}

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
}

const EXCLUDED_FUNNELS = '(4, 7)';

export async function fetchProductMatrix(input: DateRange | ProductMatrixOptions): Promise<ProductMatrixResult> {
  const opts: ProductMatrixOptions = 'period' in input ? input : { period: input };
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

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
  const nextWhere = next.length ? `AND ${next.join(' AND ')}` : '';

  const sql = `
WITH orders AS (
  SELECT d.contact_id, d.delivered_at, d.deal_id, d.head_group_name AS grp,
         d.current_manager_id::text AS mgr, d.funnel_id
    FROM sa.deals d
   WHERE d.delivered_at IS NOT NULL
     AND d.contact_id IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND d.head_group_name IS NOT NULL
     AND d.head_group_id NOT IN (${SERVICE_HEAD_GROUP_IDS.join(', ')})
),
seq AS (
  SELECT contact_id, grp,
         lead(grp)          OVER w AS next_grp,
         lead(delivered_at) OVER w AS next_at,
         lead(mgr)          OVER w AS next_mgr,
         lead(funnel_id)    OVER w AS next_funnel
    FROM orders
  WINDOW w AS (PARTITION BY contact_id ORDER BY delivered_at, deal_id)
)
SELECT grp AS from_grp, next_grp AS to_grp, count(*) AS n
  FROM seq
 WHERE next_grp IS NOT NULL
   AND next_at >= $1 AND next_at < $2
   ${nextWhere}
 GROUP BY 1, 2
`;

  const key = [
    fromIso, toExclIso,
    managerIds.length ? [...managerIds].sort().join(',') : 'm:all',
    deptIds.length ? [...deptIds].sort().join(',') : 'd:all',
    opts.dealScope ?? 'all', opts.clientType ?? 'all',
  ].join('|');
  const rows = await cached(
    `rpt:matrix2:${key}`,
    reportTtl(toExclIso),
    async () => {
      const res = await analyticsDb().query<{ from_grp: string; to_grp: string; n: string }>(sql, params);
      return res.rows;
    },
  );

  const cells: MatrixCell[] = rows.map(r => ({ from: r.from_grp, to: r.to_grp, n: Number(r.n) }));
  const rowTotals: Record<string, number> = {};
  const cats = new Set<string>();
  let total = 0;
  for (const c of cells) {
    cats.add(c.from);
    cats.add(c.to);
    rowTotals[c.from] = (rowTotals[c.from] ?? 0) + c.n;
    total += c.n;
  }
  // Порядок — по убыванию исходящих переходов: самые живые категории сверху/слева.
  const categories = [...cats].sort((a, b) => (rowTotals[b] ?? 0) - (rowTotals[a] ?? 0));
  return { categories, cells, rowTotals, total };
}
