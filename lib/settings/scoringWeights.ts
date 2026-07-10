// Веса скоринга «Карточка менеджера v2» (owners-inbox бриф 10.07, п.4) — настройка
// супер-админа (/settings/scoring-weights), хранится в scoring_weights (singleton,
// id=1, миграция 068). Тот же паттерн кэша, что lib/plans/dailyPlan.ts::getDailyPlanMode
// (TTL 60с — тумблер должен подхватываться быстро, но не дёргать БД на каждый запрос
// рейтинга карточки/сетки/агрегата отдела).
//
// Ключи ДОЛЖНЫ буквально совпадать с AxisKey (features/manager-card/engine/managerCard.ts)
// и с колонками таблицы — заводить синхронизацию тут, а не там, единственный источник
// правды на порядок/состав осей остаётся managerCard.ts (AXIS_DEFS).

import { systemDb } from '@/lib/db/clients';

export type AxisKey =
  | 'cr_deal_to_reservation'
  | 'cr_reservation_to_sale'
  | 'sales_amount'
  | 'avg_check'
  | 'touch_speed'
  | 'refusal_rate';

export const AXIS_KEYS: AxisKey[] = [
  'cr_deal_to_reservation', 'cr_reservation_to_sale', 'sales_amount',
  'avg_check', 'touch_speed', 'refusal_rate',
];

export type RawWeights = Record<AxisKey, number>;
/** Нормированные веса — сумма ровно 1 (или равные доли при вырожденном вводе). */
export type NormalizedWeights = Record<AxisKey, number>;

const EQUAL_RAW: RawWeights = {
  cr_deal_to_reservation: 5, cr_reservation_to_sale: 5, sales_amount: 5,
  avg_check: 5, touch_speed: 5, refusal_rate: 5,
};

function normalize(raw: RawWeights): NormalizedWeights {
  const sum = AXIS_KEYS.reduce((s, k) => s + Math.max(0, raw[k] ?? 0), 0);
  if (sum <= 0) {
    // Вырожденный случай (все 0 или мусор) — равные доли, как и было до весов.
    const eq = 1 / AXIS_KEYS.length;
    return Object.fromEntries(AXIS_KEYS.map(k => [k, eq])) as NormalizedWeights;
  }
  return Object.fromEntries(AXIS_KEYS.map(k => [k, Math.max(0, raw[k] ?? 0) / sum])) as NormalizedWeights;
}

let _cache: { raw: RawWeights; at: number } | null = null;
const TTL_MS = 60_000;

/** Сырые веса (0-10, для формы настроек) — из БД либо равные (дефолт/фолбэк). */
export async function getRawScoringWeights(): Promise<RawWeights> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.raw;
  let raw: RawWeights = EQUAL_RAW;
  try {
    const res = await systemDb().query<Record<AxisKey, string | number>>(
      `SELECT cr_deal_to_reservation, cr_reservation_to_sale, sales_amount,
              avg_check, touch_speed, refusal_rate
         FROM scoring_weights WHERE id = 1`,
    );
    const row = res.rows[0];
    if (row) {
      raw = Object.fromEntries(AXIS_KEYS.map(k => [k, Number(row[k])])) as RawWeights;
    }
  } catch {
    /* таблица/миграция ещё не накатана — равные веса, поведение как в v1 */
  }
  _cache = { raw, at: Date.now() };
  return raw;
}

/** Нормированные веса (сумма = 1) — то, что реально используется в формуле рейтинга. */
export async function getScoringWeights(): Promise<NormalizedWeights> {
  return normalize(await getRawScoringWeights());
}

export function invalidateScoringWeightsCache(): void {
  _cache = null;
}
