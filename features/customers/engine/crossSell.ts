import { analyticsDb, systemDb } from '@/lib/db/clients';
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

/** Награда за допродажу (доработка Серёги 01.08): какой кросс-селл бейдж и
 *  сколько ебаллов получит менеджер, если допродаст рекомендованную группу. */
export interface RecommendBadge {
  name: string;
  icon: string;
  price: number;  // ебаллы за награду (badge_prices, tier '-'); 0 = цена не задана
}

export interface Recommendation {
  /** Группы последней покупки клиента, от которых считали (пусто при фолбэке). */
  basedOn: string[];
  /** true = статистики по группе клиента мало, показан общий топ по базе. */
  fallback: boolean;
  items: { group: string; pct: number; badge?: RecommendBadge | null }[];  // по убыванию, pct 0..100
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
  const knownSet = new Set(known);
  if (known.length > 0) {
    const combined: Record<string, number> = {};
    let total = 0;
    for (const g of known) {
      const f = matrix.from[g];
      total += f.total;
      for (const [to, cnt] of Object.entries(f.to)) combined[to] = (combined[to] ?? 0) + cnt;
    }
    if (total >= MIN_TRANSITIONS_FOR_GROUP) {
      // Исключаем самоповторы — правка владельца 01.08 (то же правило, что уже
      // применено в кросс-селл квестах: «пары X→Y только с Y≠X»): «Предложить»
      // должно рекомендовать ДРУГУЮ группу, а не то, что клиент и так покупает
      // (баг живьём: клиент с двумя покупками «Ограждения» получал «40%
      // Ограждения» вместо реальных кросс-переходов кровля/утеплитель).
      // Проценты нормируются на сумму ТОЛЬКО кросс-группных переходов —
      // «из тех случаев, что вели на ДРУГУЮ группу, X% ушло в Y».
      const crossOnly: Record<string, number> = {};
      let crossTotal = 0;
      for (const [to, cnt] of Object.entries(combined)) {
        if (knownSet.has(to)) continue;
        crossOnly[to] = cnt;
        crossTotal += cnt;
      }
      if (crossTotal > 0) {
        return { basedOn: known, fallback: false, items: topN(crossOnly, crossTotal) };
      }
      // У группы клиента вообще нет статистики переходов НА ДРУГУЮ группу (в
      // данных только самоповторы) — честный фолбэк на общий топ базы, тоже
      // без самоповтора (ниже), с пометкой fallback.
    }
  }
  if (matrix.globalTotal === 0) return null;
  const globalCross: Record<string, number> = {};
  let globalCrossTotal = 0;
  for (const [to, cnt] of Object.entries(matrix.globalTo)) {
    if (knownSet.has(to)) continue;
    globalCross[to] = cnt;
    globalCrossTotal += cnt;
  }
  if (globalCrossTotal === 0) return null;
  return { basedOn: known, fallback: true, items: topN(globalCross, globalCrossTotal) };
}

// ── Награды за допродажу (доработка Серёги 01.08) ────────────────────────────
// Матчим рекомендованную пару «последняя покупка X → предложить Y» с кросс-селл
// бейджами: и пресеты (criteria {firstGroup, nextGroup}, каталог catalog.ts), и
// кастомы конструктора (crosssell_pair — те же ключи criteria). Цена — из
// badge_prices (кросс-селл бейджи без уровней → tier '-'). Если пары-бейджа
// нет — ничего не показываем (по брифу). БД — системная (YC), кэш 10 минут:
// определения меняются только из «Настройки → Награды».

interface CrossSellBadgeDef {
  name: string;
  icon: string;
  firstGroup: string;
  nextGroup: string;
  price: number;
}

export async function fetchCrossSellBadges(): Promise<CrossSellBadgeDef[]> {
  return cached('customers:crosssell-badges', 10 * 60, async () => {
    const res = await systemDb().query<{
      name: string; icon: string; first_group: string; next_group: string; price: string | null;
    }>(
      `SELECT d.name, d.icon,
              d.criteria->>'firstGroup' AS first_group,
              d.criteria->>'nextGroup'  AS next_group,
              p.price::text AS price
         FROM badge_definitions d
         LEFT JOIN badge_prices p ON p.badge_key = d.key AND p.tier = '-'
        WHERE d.enabled
          AND d.criteria ? 'firstGroup' AND d.criteria ? 'nextGroup'
        ORDER BY d.sort_order`,
    );
    return res.rows.map(r => ({
      name: r.name, icon: r.icon,
      firstGroup: r.first_group, nextGroup: r.next_group,
      price: r.price !== null ? Number(r.price) : 0,
    }));
  });
}

/**
 * Бейдж за допродажу группы `toGroup` клиенту, последняя покупка которого —
 * `basedOn` (пусто при фолбэке на общий топ — тогда пара X→Y не определена и
 * бейдж не подсказывается). При нескольких подходящих — самый дорогой.
 */
export function badgeForPair(badges: CrossSellBadgeDef[], basedOn: string[], toGroup: string): RecommendBadge | null {
  let best: RecommendBadge | null = null;
  for (const b of badges) {
    if (b.nextGroup !== toGroup || !basedOn.includes(b.firstGroup)) continue;
    if (!best || b.price > best.price) best = { name: b.name, icon: b.icon, price: b.price };
  }
  return best;
}
