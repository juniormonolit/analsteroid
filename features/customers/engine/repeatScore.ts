import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { CLIENT_KEY_CASE_SQL } from './clientKey';

// ── «Шанс на повтор»: эмпирическая вероятность следующей отгрузки ────────────
// Аудит раздела «Мои заказчики» (правка владельца 21.09: «слева направо и сверху
// вниз фокусировать менеджеров на тех, кто купит ещё раз с самой высокой
// вероятностью»). До этого порядок карточек задавали только срочность и деньги —
// а деньги и вероятность это разные вещи: разовый заказчик щебня на 240 тыс.
// стоял выше постоянника с шестью покупками.
//
// Модель НАМЕРЕННО простая и проверяемая: две таблицы частот по всей истории
// отгрузок, без обучения и подбора коэффициентов. Считаем долю отгрузок, за
// которыми в ближайшие 180 дней последовала СЛЕДУЮЩАЯ отгрузка того же
// заказчика; берём только отгрузки старше 180 дней, иначе свежие попали бы в
// знаменатель, не успев получить продолжение.
//
// Замер на живых данных (21.09.2026) — модель хорошо разделяет:
//   по числу прошлых отгрузок: 1-я → 19 % (B2C) / 27 % (B2B), 2-я → 39/46 %,
//   3-я → 56/59 %, 4–5-я → 67 %, 6+ → 86–88 %;
//   по группе последней отгрузки: «Сухие смеси» ×1,73, «Гипсокартон» ×1,60,
//   «Ограждения и заборы» ×0,72, «Грунт и навоз» ×0,54.
//
// Множитель группы применяется В ШАНСАХ (odds), а не к самой вероятности:
// умножение вероятности давало бы значения больше 100 % (проверено: до 152 %),
// а в шансах результат всегда остаётся в (0;1) и не требует обрезки.
//
// Матрица глобальная и тяжёлая (оконный LEAD по всем отгрузкам) → Redis, 24 часа,
// тот же паттерн, что у crossSell.ts.

/** Горизонт, на котором считаем «купит ещё раз». 180 дней — как в исследовании
 *  ППО: к этому сроку кривая возвратов выходит на плато. */
export const REPEAT_HORIZON_DAYS = 180;
/** Меньше стольких отгрузок в группе — статистики мало, множитель не применяем. */
const MIN_ROWS_FOR_GROUP = 200;

export interface RepeatScoreTable {
  /** «<число прошлых отгрузок, бакет>|<B2B|B2C>» → вероятность 0..1. */
  base: Record<string, number>;
  /** Группа последней отгрузки → множитель ШАНСОВ (odds ratio). */
  groupOdds: Record<string, number>;
  /** Средняя по базе — фолбэк, если бакет не найден. */
  overall: number;
}

/** Бакет по числу отгрузок, которые у заказчика УЖЕ были (включая последнюю). */
export function deliveriesBucket(n: number): string {
  if (n <= 1) return '1';
  if (n === 2) return '2';
  if (n === 3) return '3';
  if (n <= 5) return '4-5';
  return '6+';
}

const oddsOf = (p: number) => (p <= 0 ? 0 : p >= 1 ? Infinity : p / (1 - p));

export async function fetchRepeatScoreTable(): Promise<RepeatScoreTable> {
  return cached('customers:repeatScore:v1', 24 * 3600, async () => {
    const db = analyticsDb();
    // Нумеруем отгрузки заказчика и смотрим, была ли следующая в горизонте.
    const seq = `
      WITH d AS (
        SELECT (${CLIENT_KEY_CASE_SQL}) AS ck, d.delivered_at, d.head_group_name AS grp, d.funnel_id,
               ROW_NUMBER() OVER (PARTITION BY (${CLIENT_KEY_CASE_SQL}) ORDER BY d.delivered_at, d.deal_id) AS rn,
               LEAD(d.delivered_at) OVER (PARTITION BY (${CLIENT_KEY_CASE_SQL}) ORDER BY d.delivered_at, d.deal_id) AS nxt
          FROM sa.deals d
         WHERE d.delivered_at IS NOT NULL AND d.funnel_id IN (0,1,2,3)
      ),
      m AS (
        SELECT * FROM d
         WHERE ck IS NOT NULL AND delivered_at < now() - interval '${REPEAT_HORIZON_DAYS} days'
      )`;
    const repeated = `(nxt IS NOT NULL AND nxt <= delivered_at + interval '${REPEAT_HORIZON_DAYS} days')`;

    const [baseRes, grpRes, allRes] = await Promise.all([
      db.query<{ bucket: string; kind: string; p: string }>(`${seq}
        SELECT CASE WHEN rn=1 THEN '1' WHEN rn=2 THEN '2' WHEN rn=3 THEN '3' WHEN rn<=5 THEN '4-5' ELSE '6+' END AS bucket,
               CASE WHEN funnel_id IN (1,3) THEN 'B2B' ELSE 'B2C' END AS kind,
               (count(*) FILTER (WHERE ${repeated})::numeric / count(*))::text AS p
          FROM m GROUP BY 1,2`),
      db.query<{ grp: string; p: string; n: string }>(`${seq}
        SELECT grp, (count(*) FILTER (WHERE ${repeated})::numeric / count(*))::text AS p, count(*)::text AS n
          FROM m WHERE grp IS NOT NULL GROUP BY 1 HAVING count(*) >= ${MIN_ROWS_FOR_GROUP}`),
      db.query<{ p: string }>(`${seq}
        SELECT (count(*) FILTER (WHERE ${repeated})::numeric / count(*))::text AS p FROM m`),
    ]);

    const overall = Number(allRes.rows[0]?.p ?? 0.25);
    const base: Record<string, number> = {};
    for (const r of baseRes.rows) base[`${r.bucket}|${r.kind}`] = Number(r.p);
    const groupOdds: Record<string, number> = {};
    const oAll = oddsOf(overall);
    for (const r of grpRes.rows) {
      const o = oddsOf(Number(r.p));
      if (oAll > 0 && Number.isFinite(o)) groupOdds[r.grp] = o / oAll;
    }
    return { base, groupOdds, overall };
  });
}

/**
 * Шанс, что заказчик отгрузится ещё раз в ближайшие 180 дней, 0..1.
 * deliveries — сколько отгрузок у него уже было, group — группа последней,
 * isCompany — юрлицо. Вероятность из бакета, множитель группы — в шансах.
 */
export function repeatChance(
  t: RepeatScoreTable,
  deliveries: number,
  group: string | null,
  isCompany: boolean,
): number | null {
  if (deliveries <= 0) return null;                       // отгрузок не было — не о чем судить
  const p = t.base[`${deliveriesBucket(deliveries)}|${isCompany ? 'B2B' : 'B2C'}`] ?? t.overall;
  const mult = group ? (t.groupOdds[group] ?? 1) : 1;
  if (mult === 1) return p;
  const o = oddsOf(p) * mult;
  return Number.isFinite(o) ? o / (1 + o) : p;
}
