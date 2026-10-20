// «Потенциал заказчика» в канбане повторных (владелец 20.10: «сколько денег в потенциале
// при статистических показателях среднего чека и конверсии из первой отгрузки в хвост»).
//
// Определение (уточнено 20.10): ПОТЕНЦИАЛ = сколько заказчик принесёт за год, если вернётся —
// средний «хвост» за 365 дней у вернувшихся таких же заказчиков в истории. Для каждой покупки старше года смотрим, сколько тот же заказчик
// купил в следующие 365 дней (0 — не вернулся). Среднее по сегменту = конверсия в хвост ×
// средний хвост вернувшихся, одним числом, без двойного счёта.
// Сегмент: номер покупки (бакеты 1 / 2 / 3 / 4–5 / 6+, как у «шанса на повтор») × B2C/B2B.
// Выбросы (B2B-гиганты) режем: хвост ограничен 95-м перцентилем своего сегмента.
// Покупки — склеенные по правилу повторной продажи (lib/metrics/repeatRule.ts).
import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import { deliveriesBucket } from '@/features/customers/engine/repeatScore';
import { isNewPurchaseSql } from '@/lib/metrics/repeatRule';

const TAIL_DAYS = 365;

export interface TailTable {
  /** «бакет|B2B|B2C» → { mean: средний хвост за 365 дн., conv: доля вернувшихся, n: покупок в выборке }. */
  seg: Record<string, { mean: number; conv: number; n: number }>;
}

export async function fetchTailTable(): Promise<TailTable> {
  return cached('repeat-kanban:tail365:v1', 24 * 3600, async () => {
    const res = await analyticsDb().query<{ bucket: string; kind: string; mean: string; conv: string; n: string }>(`
      WITH raw AS (
        SELECT (${CLIENT_KEY_CASE_SQL}) AS client_key, d.deal_id, d.delivered_at AS at, d.amount, d.head_group_name AS grp, d.funnel_id
          FROM sa.deals d WHERE d.delivered_at IS NOT NULL AND d.funnel_id IN (0,1,2,3)
      ),
      flagged AS (
        SELECT r.*, ${isNewPurchaseSql('r.at', 'r.grp', 'lag(r.at) OVER w', 'lag(r.grp) OVER w')} AS is_new
          FROM raw r WHERE r.client_key IS NOT NULL
        WINDOW w AS (PARTITION BY r.client_key ORDER BY r.at, r.deal_id)
      ),
      pur AS (
        SELECT client_key, pno, min(at) AS at, sum(amount) AS amount, min(funnel_id) AS funnel_id
          FROM (SELECT *, sum(is_new) OVER (PARTITION BY client_key ORDER BY at, deal_id ROWS UNBOUNDED PRECEDING) AS pno FROM flagged) z
         GROUP BY client_key, pno
      ),
      numbered AS (
        SELECT p.*, ROW_NUMBER() OVER (PARTITION BY client_key ORDER BY at, pno) AS rn FROM pur p
      ),
      -- Хвост — соединением по заказчику (hash join), не коррелированным подзапросом по CTE:
      -- у CTE нет индекса, подзапрос на ~30 тыс. покупок давал бы O(n²).
      tails AS (
        SELECT a.client_key, a.rn, a.funnel_id, coalesce(sum(b.amount), 0) AS tail
          FROM numbered a
          LEFT JOIN numbered b ON b.client_key = a.client_key AND b.at > a.at AND b.at <= a.at + interval '${TAIL_DAYS} days'
         WHERE a.at < now() - interval '${TAIL_DAYS} days'
         GROUP BY a.client_key, a.pno, a.rn, a.funnel_id
      ),
      seg AS (
        SELECT CASE WHEN rn=1 THEN '1' WHEN rn=2 THEN '2' WHEN rn=3 THEN '3' WHEN rn<=5 THEN '4-5' ELSE '6+' END AS bucket,
               CASE WHEN funnel_id IN (1,3) THEN 'B2B' ELSE 'B2C' END AS kind, tail
          FROM tails
      ),
      caps AS (
        SELECT bucket, kind, percentile_cont(0.95) WITHIN GROUP (ORDER BY tail) AS cap FROM seg GROUP BY 1,2
      )
      SELECT s.bucket, s.kind,
             avg(least(s.tail, c.cap))::text AS mean,
             (count(*) FILTER (WHERE s.tail > 0)::numeric / count(*))::text AS conv,
             count(*)::text AS n
        FROM seg s JOIN caps c USING (bucket, kind)
       GROUP BY 1, 2`);
    const seg: TailTable['seg'] = {};
    for (const r of res.rows) seg[`${r.bucket}|${r.kind}`] = { mean: Math.round(Number(r.mean)), conv: Number(r.conv), n: Number(r.n) };
    return { seg };
  });
}

/** Разбор потенциала для подсказки на карточке: из чего сложилось число. */
export interface PotentialInfo {
  /** Бакет числа покупок: '1' | '2' | '3' | '4-5' | '6+'. */
  bucket: string;
  b2b: boolean;
  /** Сколько таких покупок в истории (выборка). */
  n: number;
  /** Доля вернувшихся в течение года. */
  conv: number;
  /** Средняя выручка за год у вернувшихся (mean / conv). */
  avgReturned: number;
  /** Средний хвост по всем, вкл. не вернувшихся (conv × avgReturned) — справочно. */
  expected: number;
  /** Потенциал = avgReturned: выручка за год, если заказчик вернётся. */
  value: number;
}

/** Потенциал заказчика на 12 мес. по его сегменту (null — сегмента нет в статистике). */
export function tailPotential(t: TailTable, purchases: number, isB2B: boolean): PotentialInfo | null {
  if (purchases <= 0) return null;
  const bucket = deliveriesBucket(purchases);
  const s = t.seg[`${bucket}|${isB2B ? 'B2B' : 'B2C'}`];
  if (!s) return null;
  // Потенциал = сколько заказчик принесёт за год, ЕСЛИ вернётся (средний хвост вернувшихся), —
  // цель для работы, а не прогноз с вероятностью (владелец 20.10: «должно заманивать, а не
  // показывать, что с вероятностью 18 % на кону 23 тыщи»). Средневзвешенный по всем — expected.
  const avgReturned = s.conv > 0 ? Math.round(s.mean / s.conv) : 0;
  return { bucket, b2b: isB2B, n: s.n, conv: s.conv, avgReturned, expected: s.mean, value: avgReturned };
}
