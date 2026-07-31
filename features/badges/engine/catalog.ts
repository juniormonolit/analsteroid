// Каталог бейджей (задача 2655, этап 1). Это СИД: при пересчёте каталог
// заливается в badge_definitions с ON CONFLICT (key) DO NOTHING — правки
// порогов/имён/вкл-выкл из «Настройки → Награды» переживают деплой и НЕ
// перетираются. Конструктора новых бейджей на этапе 1 нет (решение владельца).
// Чистый модуль (без pg) — используется и сервером, и клиентской полкой.

export type BadgeTier = 'bronze' | 'silver' | 'gold' | 'platinum';
export type BadgeCategory =
  | 'top' | 'crosssell' | 'repeat' | 'speed' | 'record' | 'streak' | 'hygiene' | 'milestone' | 'rare';

export interface BadgeDef {
  key: string;
  name: string;
  description: string;
  icon: string;
  category: BadgeCategory;
  tiered: boolean;
  criteria: Record<string, unknown>;
  sortOrder: number;
}

export const TIER_ORDER: BadgeTier[] = ['bronze', 'silver', 'gold', 'platinum'];

export const TIER_LABELS: Record<BadgeTier, string> = {
  bronze: 'Бронза', silver: 'Серебро', gold: 'Золото', platinum: 'Платина',
};

// Уровень топ-бейджа = масштаб победы: лучший в отделе — бронза, в департаменте —
// серебро, в филиале — золото, в стране — платина (решение Серёги).
export const TIER_SCOPE_LABELS: Record<BadgeTier, string> = {
  bronze: 'лучший в отделе', silver: 'лучший в департаменте',
  gold: 'лучший в филиале', platinum: 'лучший в стране',
};

// Цвета уровней (без внешних ассетов, обе темы читаемы).
export const TIER_COLORS: Record<BadgeTier, string> = {
  bronze: '#cd7f32', silver: '#9ca3af', gold: '#f59e0b', platinum: '#38bdf8',
};

export const PERIOD_LABELS: Record<string, string> = {
  day: 'за день', week: 'за неделю', month: 'за месяц', year: 'за год',
};

// Топ-10 кросс-селл связок ИЗ ДАННЫХ (LEAD по клиенту, товарные head-группы позиций
// products, услуги/доставка/«Разное» исключены; частоты на 31.07.2026 — в скобках).
export const CROSS_SELL_PAIRS: { key: string; first: string; next: string; name: string; freq: number }[] = [
  { key: 'crosssell_plity_teplo',   first: 'Плитные материалы', next: 'Теплоизоляция и утеплитель', name: 'Допродал утеплитель к плитам', freq: 419 },
  { key: 'crosssell_teplo_plity',   first: 'Теплоизоляция и утеплитель', next: 'Плитные материалы', name: 'Допродал плиты к утеплителю', freq: 407 },
  { key: 'crosssell_teplo_krovlya', first: 'Теплоизоляция и утеплитель', next: 'Кровельные материалы, водосточные системы', name: 'С утеплителя — на кровлю', freq: 321 },
  { key: 'crosssell_pesok_scheben', first: 'Песок', next: 'Щебень', name: 'Песок, а сверху щебень', freq: 308 },
  { key: 'crosssell_scheben_pesok', first: 'Щебень', next: 'Песок', name: 'Щебень, а к нему песок', freq: 288 },
  { key: 'crosssell_krovlya_teplo', first: 'Кровельные материалы, водосточные системы', next: 'Теплоизоляция и утеплитель', name: 'С кровли — на утепление', freq: 278 },
  { key: 'crosssell_zabor_krovlya', first: 'Ограждения и заборы', next: 'Кровельные материалы, водосточные системы', name: 'Забор поставил — крышу продал', freq: 228 },
  { key: 'crosssell_krovlya_fasad', first: 'Кровельные материалы, водосточные системы', next: 'Фасад', name: 'После кровли — фасад', freq: 228 },
  { key: 'crosssell_krovlya_zabor', first: 'Кровельные материалы, водосточные системы', next: 'Ограждения и заборы', name: 'Крыша есть — будет и забор', freq: 211 },
  { key: 'crosssell_fasad_krovlya', first: 'Фасад', next: 'Кровельные материалы, водосточные системы', name: 'Фасад отделал — кровлю добил', freq: 195 },
];

export const BADGE_CATALOG: BadgeDef[] = [
  // ── Периодические топы (уровни по масштабу) ────────────────────────────────
  {
    key: 'top_sales', name: 'Топ продаж', icon: '🏆', category: 'top', tiered: true, sortOrder: 10,
    description: 'Лучшая сумма продаж за день/неделю/месяц/год. Бронза — лучший в отделе, серебро — в департаменте, золото — в филиале, платина — в стране.',
    criteria: { metric: 'sales_amount', minAmount: 1 },
  },
  {
    key: 'top_shipments', name: 'Топ отгрузок', icon: '🚚', category: 'top', tiered: true, sortOrder: 11,
    description: 'Лучшая сумма отгрузок за день/неделю/месяц/год. Уровни — по масштабу победы, как у «Топ продаж».',
    criteria: { metric: 'shipments_amount', minAmount: 1 },
  },
  {
    key: 'top_repeat_sales', name: 'Топ повторных продаж', icon: '🔁', category: 'top', tiered: true, sortOrder: 12,
    description: 'Лучшая сумма продаж по повторным воронкам за день/неделю/месяц/год. Уровни — по масштабу победы.',
    criteria: { metric: 'repeat_sales_amount', minAmount: 1 },
  },

  // ── Кросс-селл: связки из данных ───────────────────────────────────────────
  ...CROSS_SELL_PAIRS.map((p, i): BadgeDef => ({
    key: p.key, name: p.name, icon: '🧩', category: 'crosssell', tiered: false, sortOrder: 20 + i,
    description: `Клиент купил «${p.first}», а следующей сделкой вы допродали ему «${p.next}». Счётчик растёт с каждой такой парой.`,
    criteria: { firstGroup: p.first, nextGroup: p.next },
  })),

  // ── Редкие ачивки ──────────────────────────────────────────────────────────
  {
    key: 'combo_master', name: 'Мастер комбо', icon: '🎯', category: 'rare', tiered: false, sortOrder: 30,
    description: 'Собрал кросс-селл связки пяти разных видов — умеет допродавать что угодно к чему угодно.',
    criteria: { minPairs: 5 },
  },
  {
    key: 'universal', name: 'Универсал', icon: '🌈', category: 'rare', tiered: false, sortOrder: 31,
    description: 'Продажи в 10 и более разных товарных группах.',
    criteria: { minGroups: 10 },
  },

  // ── Повторные продажи ──────────────────────────────────────────────────────
  {
    key: 'return_client', name: 'Вернул клиента', icon: '🤝', category: 'repeat', tiered: false, sortOrder: 40,
    description: 'Клиент вернулся и купил снова — и первую повторную продажу этому клиенту сделали вы. Счётчик — сколько клиентов вернули.',
    criteria: {},
  },
  {
    key: 'loyal_client', name: 'Постоянник', icon: '💎', category: 'repeat', tiered: false, sortOrder: 41,
    description: 'Есть клиент, купивший у вас 3 и более раз повторно. Счётчик — сколько таких постоянных клиентов.',
    criteria: { minRepeats: 3 },
  },

  // ── Скорость ───────────────────────────────────────────────────────────────
  {
    key: 'same_day_sale', name: 'Продал день в день', icon: '⚡', category: 'speed', tiered: false, sortOrder: 50,
    description: 'Сделка создана и продана в один день. Счётчик — сколько раз получилось.',
    criteria: {},
  },
  {
    key: 'faster_than_median', name: 'Быстрее медианы группы', icon: '🏎️', category: 'speed', tiered: false, sortOrder: 51,
    description: 'За месяц ваша медианная скорость от создания сделки до продажи выше медианы вашего отдела (при 3+ продажах за месяц).',
    criteria: { minDeals: 3 },
  },

  // ── Личный рекорд ──────────────────────────────────────────────────────────
  {
    key: 'personal_day_record', name: 'Личный рекорд дня', icon: '📈', category: 'record', tiered: false, sortOrder: 60,
    description: 'Продажи за день превысили ваш прежний лучший день. Каждый новый рекорд — отдельная награда.',
    criteria: {},
  },

  // ── Стрики ─────────────────────────────────────────────────────────────────
  {
    key: 'streak_5', name: 'Серия: 5 дней подряд', icon: '🔥', category: 'streak', tiered: false, sortOrder: 70,
    description: '5 рабочих дней подряд хотя бы с одной продажей (по производственному календарю РФ).',
    criteria: { days: 5 },
  },
  {
    key: 'streak_10', name: 'Серия: 10 дней подряд', icon: '🌋', category: 'streak', tiered: false, sortOrder: 71,
    description: '10 рабочих дней подряд хотя бы с одной продажей — настоящий марафон.',
    criteria: { days: 10 },
  },

  // ── Гигиена воронки ────────────────────────────────────────────────────────
  {
    key: 'clean_week', name: 'Чистая воронка', icon: '🧹', category: 'hygiene', tiered: false, sortOrder: 80,
    description: 'На конец недели ни одной открытой сделки старше отсечки своей товарной группы (и была хотя бы одна продажа за неделю).',
    criteria: {},
  },

  // ── Вехи ───────────────────────────────────────────────────────────────────
  {
    key: 'first_sale', name: 'Первая продажа', icon: '🌟', category: 'milestone', tiered: false, sortOrder: 90,
    description: 'Первая проданная сделка — с почином!',
    criteria: {},
  },
  {
    key: 'sales_100', name: 'Сотня продаж', icon: '💯', category: 'milestone', tiered: false, sortOrder: 91,
    description: '100 проданных сделок.',
    criteria: { count: 100 },
  },
  {
    key: 'big_deal', name: 'Крупная рыба', icon: '🐋', category: 'milestone', tiered: false, sortOrder: 92,
    description: 'Продана сделка на миллион и больше. Счётчик — сколько таких сделок.',
    criteria: { minAmount: 1000000 },
  },
  {
    key: 'million_day', name: 'День-миллионник', icon: '💰', category: 'milestone', tiered: false, sortOrder: 93,
    description: 'Продажи за один день на миллион и больше. Счётчик — сколько таких дней.',
    criteria: { minAmount: 1000000 },
  },
];

export const BADGE_BY_KEY = new Map(BADGE_CATALOG.map(b => [b.key, b]));
