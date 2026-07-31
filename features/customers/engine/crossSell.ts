import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';

// ── Кросс-селл рекомендации «что предложить» (дополнение Серёги 01.08) ──────
// Матрица переходов «head-группа X → следующая покупка группы Y» по клиенту —
// ТА ЖЕ механика, что кросс-селл бейджи (features/badges/engine/compute.ts::
// fetchCrossSellTransitions): оконный LEAD по клиенту, head-группы позиций
// products, услуги/доставка/«Разное» исключены. Отличия: клиент здесь единый
// ключ физ/юр (contact_id/company_id, как во всём разделе «Мои заказчики»),
// переходы считаются по ВСЕЙ истории продаж (матрице ретро-отсечка не нужна).
//
// P(Y|X) = частота пары X→Y / все переходы из X. Переход X→X (клиент повторно
// берёт ту же группу) НЕ исключается — «предложить то же самое» для повторки
// валидная и частая рекомендация; вероятности честные, по убыванию.
//
// Матрица глобальная и тяжёлая (full-scan продаж) → Redis-кэш 24 часа
// (паттерн «обновление при обращении с кэшем» — ночного тика у раздела нет).

/** Меньше стольких переходов из группы клиента = статистики мало, фолбэк на
 *  общий топ следующих покупок по базе (порог из брифа Серёги). */
export const MIN_TRANSITIONS_FOR_GROUP = 30;
const TOP_N = 3;

export interface CrossSellMatrix {
  /** from-группа → { total: всего переходов из неё, to: { to-группа → счётчик } } */
  from: Record<string, { total: number; to: Record<string, number> }>;
  /** Общий топ «следующих покупок» по базе (фолбэк): группа → счётчик. */
  globalTo: Record<string, number>;
  globalTotal: number;
}

export interface Recommendation {
  /** Группы последней покупки клиента, от которых считали (пусто при фолбэке). */
  basedOn: string[];
  /** true = статистики по группе клиента мало, показан общий топ по базе. */
  fallback: boolean;
  items: { group: string; pct: number }[];  // по убыванию, pct 0..100
}

const MATRIX_SQL = `
WITH dg AS (
  SELECT (CASE WHEN d.funnel_id IN (0,2) THEN 'c'||d.contact_id ELSE 'k'||d.company_id END) AS client_key,
         d.sold_at, d.deal_id,
         array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
               WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                 AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps
  FROM sa.deals d
  WHERE d.sold_at IS NOT NULL AND d.funnel_id IN (0,1,2,3)
    AND (CASE WHEN d.funnel_id IN (0,2) THEN d.contact_id ELSE d.company_id END) IS NOT NULL
), seq AS (
  SELECT grps AS prev_grps,
         LEAD(grps) OVER (PARTITION BY client_key ORDER BY sold_at, deal_id) AS next_grps
  FROM dg
)
SELECT x AS from_group, y AS to_group, count(*)::int AS cnt
FROM seq, unnest(prev_grps) x, unnest(next_grps) y
WHERE next_grps IS NOT NULL
GROUP BY 1, 2
`;

export async function fetchCrossSellMatrix(): Promise<CrossSellMatrix> {
  return cached('customers:crosssell-matrix', 24 * 60 * 60, async () => {
    const res = await analyticsDb().query<{ from_group: string; to_group: string; cnt: number }>(MATRIX_SQL);
    const matrix: CrossSellMatrix = { from: {}, globalTo: {}, globalTotal: 0 };
    for (const r of res.rows) {
      const f = (matrix.from[r.from_group] ??= { total: 0, to: {} });
      f.total += r.cnt;
      f.to[r.to_group] = (f.to[r.to_group] ?? 0) + r.cnt;
      matrix.globalTo[r.to_group] = (matrix.globalTo[r.to_group] ?? 0) + r.cnt;
      matrix.globalTotal += r.cnt;
    }
    return matrix;
  });
}

function topN(counts: Record<string, number>, total: number): { group: string; pct: number }[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([group, cnt]) => ({ group, pct: Math.round((cnt / total) * 100) }));
}

/**
 * Рекомендация для клиента по группам его ПОСЛЕДНЕЙ покупки (последняя проданная
 * сделка с товарными позициями). Если групп несколько — счётчики переходов из
 * них складываются (общая нормировка). Мало статистики (<MIN_TRANSITIONS_FOR_GROUP
 * суммарных переходов) или покупок с товарами нет — общий топ по базе с пометкой.
 */
export function recommendFor(matrix: CrossSellMatrix, lastGroups: string[]): Recommendation | null {
  const known = lastGroups.filter(g => matrix.from[g]);
  if (known.length > 0) {
    const combined: Record<string, number> = {};
    let total = 0;
    for (const g of known) {
      const f = matrix.from[g];
      total += f.total;
      for (const [to, cnt] of Object.entries(f.to)) combined[to] = (combined[to] ?? 0) + cnt;
    }
    if (total >= MIN_TRANSITIONS_FOR_GROUP) {
      return { basedOn: known, fallback: false, items: topN(combined, total) };
    }
  }
  if (matrix.globalTotal === 0) return null;
  return { basedOn: [], fallback: true, items: topN(matrix.globalTo, matrix.globalTotal) };
}
