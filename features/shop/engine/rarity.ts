// Редкость товаров/бустов магазина (задача 2960, ТЗ Серёги 04.08): «Минимальный
// уровень для покупки — прикольная механика, из неё можно редкость проставлять
// от обычного до легендарного». Редкость НЕ вводится руками — считается
// АВТОМАТИЧЕСКИ от min_level по фиксированной шкале (эта функция — единственный
// источник правды, использовать и в форме настроек, и на витрине).
//
// Шкала обоснована реальным распределением уровней XP (features/xp/engine/xp.ts,
// levelFromXp) на 04.08.2026 — прогон по xp_ledger, 195 менеджеров с ненулевым
// XP (прод, YC system): min 0 / p10 0 / p25 1 / медиана 4 / p75 11 / p90 24 /
// p95 29 / p99 34 / max 44. Пороги подобраны так, чтобы:
//  - «обычный» покрывал típичного новичка/полу-активного (уровни 0-2 — это
//    ровно p0..p50, «купит почти каждый»);
//  - «легендарный» был ДОСТИЖИМ, а не пустой полкой — на 04.08 порог 30
//    выполняют 10 из 195 менеджеров (топ ~5%, включая оба реальных максимума
//    43 и 44), а не 0.
// Порог не перепроверяется автоматически (не читает БД на каждый рендер) —
// если распределение уровней сильно уедет, пересмотреть константы здесь.
export interface RarityTier {
  key: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  label: string;
  /** Порог: минимальный min_level товара, с которого действует этот тир. */
  levelFrom: number;
  /** Акцентный цвет — рамка карточки/бейдж редкости. */
  color: string;
  /** ~доля менеджеров (04.08), которым тир доступен по уровню — только для подсказки в форме. */
  reachShare: number;
}

export const RARITY_TIERS: readonly RarityTier[] = [
  { key: 'common', label: 'Обычный', levelFrom: 0, color: '#868e96', reachShare: 1 },
  { key: 'uncommon', label: 'Необычный', levelFrom: 3, color: '#2f9e44', reachShare: 0.57 },
  { key: 'rare', label: 'Редкий', levelFrom: 8, color: '#1c7ed6', reachShare: 0.36 },
  { key: 'epic', label: 'Эпический', levelFrom: 16, color: '#9c36b5', reachShare: 0.19 },
  { key: 'legendary', label: 'Легендарный', levelFrom: 30, color: '#f08c00', reachShare: 0.051 },
] as const;

/** Тир редкости ОТ минимального уровня покупки (по убыванию порога — первое совпадение). */
export function rarityForLevel(minLevel: number): RarityTier {
  for (let i = RARITY_TIERS.length - 1; i >= 0; i--) {
    if (minLevel >= RARITY_TIERS[i].levelFrom) return RARITY_TIERS[i];
  }
  return RARITY_TIERS[0];
}

/** Следующий тир (для подсказки «ещё +N уровней → Редкий») — null на легендарном. */
export function nextRarityTier(minLevel: number): RarityTier | null {
  const cur = rarityForLevel(minLevel);
  const idx = RARITY_TIERS.findIndex(t => t.key === cur.key);
  return RARITY_TIERS[idx + 1] ?? null;
}
