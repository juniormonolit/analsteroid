import { systemDb } from '@/lib/db/clients';

// Разметка стадий «Нет цены / Есть цена / Спорно» (задача владельца 01.09,
// миграция 196). Таблица stage_price_markup в system; правится в
// «Настройки → Цена: разметка стадий». Потребитель — движок скорости
// озвучивания цены (features/reports/engine/priceSpeed.ts).
//
// Семантика состояний:
//  - 'has_price' — стадия невозможна без озвученной цены: ПЕРВЫЙ вход сделки в
//    любую такую стадию = момент озвучивания;
//  - 'no_price' — цена ещё не озвучена (и дефолт для НЕразмеченных стадий —
//    новые стадии из Битрикса не ломают метрику, а подсвечиваются в настройках);
//  - 'unclear' — «Спорно», не участвует в расчёте: сделка, зашедшая в спорную
//    стадию ДО первой ценовой, исключается из числителя и знаменателя.
export type PriceStageState = 'no_price' | 'has_price' | 'unclear';

export const PRICE_STAGE_STATES: PriceStageState[] = ['no_price', 'has_price', 'unclear'];

let _cache: { map: Map<string, PriceStageState>; at: number } | null = null;
const TTL_MS = 60_000; // правка в настройках должна подхватиться быстро, но не дёргать system на каждый отчёт

export async function loadPriceStageMarkup(): Promise<Map<string, PriceStageState>> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.map;
  const res = await systemDb().query<{ stage_id: string; state: PriceStageState }>(
    `SELECT stage_id, state FROM stage_price_markup`,
  );
  const map = new Map(res.rows.map(r => [r.stage_id, r.state]));
  _cache = { map, at: Date.now() };
  return map;
}

export function invalidatePriceStageMarkupCache(): void {
  _cache = null;
}

/** Наборы stage_id для SQL движка: ценовые и спорные. Неразмеченные = 'no_price'. */
export async function loadPriceStageSets(): Promise<{ hasPrice: string[]; unclear: string[] }> {
  const map = await loadPriceStageMarkup();
  const hasPrice: string[] = [];
  const unclear: string[] = [];
  for (const [id, state] of map) {
    if (state === 'has_price') hasPrice.push(id);
    else if (state === 'unclear') unclear.push(id);
  }
  return { hasPrice, unclear };
}
