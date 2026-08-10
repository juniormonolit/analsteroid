import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { SERVICE_HEAD_GROUP_IDS } from '@/lib/metrics/serviceGroups';
import type { DateRange } from '@/lib/period';
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
}

const EXCLUDED_FUNNELS = '(4, 7)';

export async function fetchProductMatrix(period: DateRange): Promise<ProductMatrixResult> {
  const fromIso = period.from.toISOString();
  const toExclIso = addDays(startOfDay(period.to), 1).toISOString();

  const sql = `
WITH orders AS (
  SELECT d.contact_id, d.delivered_at, d.deal_id, d.head_group_name AS grp
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
         lead(delivered_at) OVER w AS next_at
    FROM orders
  WINDOW w AS (PARTITION BY contact_id ORDER BY delivered_at, deal_id)
)
SELECT grp AS from_grp, next_grp AS to_grp, count(*) AS n
  FROM seq
 WHERE next_grp IS NOT NULL
   AND next_at >= $1 AND next_at < $2
 GROUP BY 1, 2
`;

  const rows = await cached(
    `rpt:matrix:${fromIso}|${toExclIso}`,
    reportTtl(toExclIso),
    async () => {
      const res = await analyticsDb().query<{ from_grp: string; to_grp: string; n: string }>(
        sql, [fromIso, toExclIso],
      );
      return res.rows;
    },
  );

  const cells: MatrixCell[] = rows.map(r => ({ from: r.from_grp, to: r.to_grp, n: Number(r.n) }));
  const rowTotals: Record<string, number> = {};
  const cats = new Set<string>();
  for (const c of cells) {
    cats.add(c.from);
    cats.add(c.to);
    rowTotals[c.from] = (rowTotals[c.from] ?? 0) + c.n;
  }
  // Порядок — по убыванию исходящих переходов: самые живые категории сверху/слева.
  const categories = [...cats].sort((a, b) => (rowTotals[b] ?? 0) - (rowTotals[a] ?? 0));
  return { categories, cells, rowTotals };
}
