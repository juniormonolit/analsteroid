// Редкость товаров/бустов магазина (задача 2983, правка владельца 04.08 к
// задаче 2960): редкость считается ОТ ЦЕНЫ товара в MLT, а НЕ от min_level.
// min_level — отдельная антифарм-защита («чтобы менеджер хитростью за два
// месяца не нафармил айфон», см. app/api/shop/route.ts, гейт покупки) —
// она блокирует покупку ниже уровня, но больше НЕ определяет визуальную
// редкость карточки. Эта функция — единственный источник правды, использовать
// и в форме настроек, и на витрине (обе стороны читают price_units/priceEball,
// не min_level).
//
// Шкала обоснована фактическим каталогом на 04.08.2026 (junibaseone.shop_items,
// 16 реальных позиций без тестовой ZZZ_test_2960_legendary) и курсом
// 1 MLT = 7,5 ₽ (правка владельца): реальные цены каталога — от 25 до 15 000 MLT
// (188 ₽ — 112 500 ₽). Пороги подобраны так, чтобы:
//  - «обычный» покрывал дешёвые расходники (Кофе 25, Титул 50, Поздний старт
//    +2ч 100, Термокружка 150, Сброс мёртвых сделок 150 — 5 позиций до 200 MLT);
//  - тиры дальше растут по каталогу примерно вдвое-втрое за шаг (Приоритет
//    лидов/Наушники/Мерч-бокс/Отгул 250-500 → Пицца-день/Кресло/Поздний старт
//    отдела 800-1500 → Монитор/Тимбилдинг 2000-5000);
//  - «легендарный» стартует с 10 000 MLT (75 000 ₽) — ДОСТИЖИМ, а не пустая
//    полка: Смартфон (10 000) и iPhone (15 000), 2 из 16 позиций (~12%, топ);
//  - пример владельца — гипотетический айфон за 150 000 ₽ (= 20 000 MLT) —
//    гарантированно легендарный: 20 000 ≥ порога 10 000 MLT с запасом.
// Распределение по каталогу на 04.08 (16 реальных позиций, без тестовой):
// common 5 · uncommon 4 · rare 3 · epic 2 · legendary 2.
// Порог не перепроверяется автоматически (не читает БД на каждый рендер) —
// если каталог сильно уедет по ценам, пересмотреть константы здесь.
export interface RarityTier {
  key: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  label: string;
  /** Порог: минимальная цена в MLT (priceEball), с которой действует этот тир. */
  priceFrom: number;
  /** Тот же порог в рублях по курсу 1 MLT = 7,5 ₽ — только для подсказки в форме. */
  rubFrom: number;
  /** Акцентный цвет — рамка карточки/бейдж редкости. */
  color: string;
}

export const RARITY_TIERS: readonly RarityTier[] = [
  { key: 'common', label: 'Обычный', priceFrom: 0, rubFrom: 0, color: '#868e96' },
  { key: 'uncommon', label: 'Необычный', priceFrom: 200, rubFrom: 1_500, color: '#2f9e44' },
  { key: 'rare', label: 'Редкий', priceFrom: 600, rubFrom: 4_500, color: '#1c7ed6' },
  { key: 'epic', label: 'Эпический', priceFrom: 2_000, rubFrom: 15_000, color: '#9c36b5' },
  { key: 'legendary', label: 'Легендарный', priceFrom: 10_000, rubFrom: 75_000, color: '#f08c00' },
] as const;

/** Тир редкости ОТ цены в MLT (priceEball) — по убыванию порога, первое совпадение. */
export function rarityForPrice(priceEball: number): RarityTier {
  for (let i = RARITY_TIERS.length - 1; i >= 0; i--) {
    if (priceEball >= RARITY_TIERS[i].priceFrom) return RARITY_TIERS[i];
  }
  return RARITY_TIERS[0];
}

/** Следующий тир (для подсказки «ещё +N MLT → Редкий») — null на легендарном. */
export function nextRarityTier(priceEball: number): RarityTier | null {
  const cur = rarityForPrice(priceEball);
  const idx = RARITY_TIERS.findIndex(t => t.key === cur.key);
  return RARITY_TIERS[idx + 1] ?? null;
}
