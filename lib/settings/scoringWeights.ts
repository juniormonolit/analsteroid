// Веса скоринга «Карточка менеджера v2» (owners-inbox бриф 10.07, п.4) — настройка
// супер-админа (/settings/scoring-weights), хранится в scoring_weights (singleton,
// id=1, миграция 068). Тот же паттерн кэша, что lib/plans/dailyPlan.ts::getDailyPlanMode
// (TTL 60с — тумблер должен подхватываться быстро, но не дёргать БД на каждый запрос
// рейтинга карточки/сетки/агрегата отдела).
//
// Ключи ДОЛЖНЫ буквально совпадать с колонками таблицы — заводить синхронизацию тут,
// а не там; единственный источник правды на порядок/СОСТАВ осей — managerCard.ts
// (AXIS_DEFS, полный каталог 8 осей после card_templates, бриф 10.07); эти 6 —
// подмножество каталога, для которого ЕСТЬ настраиваемый вес (остальные 2 — дефолт-вес
// 5, см. weightForAxis в managerCard.ts).
//
// getRawScoringWeights() — то, что реально читает движок (managerCard.ts::ratingFor
// принимает СЫРЫЕ веса 0-10 и сам renормирует по факту использованных осей шаблона,
// см. комментарий у ratingFor) — нормировка «сумма=1» движку больше не нужна.

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

const EQUAL_RAW: RawWeights = {
  cr_deal_to_reservation: 5, cr_reservation_to_sale: 5, sales_amount: 5,
  avg_check: 5, touch_speed: 5, refusal_rate: 5,
};

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

export function invalidateScoringWeightsCache(): void {
  _cache = null;
}
