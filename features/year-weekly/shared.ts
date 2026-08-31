// Общие типы и список сущностей спец-отчёта «Данные по годам» — БЕЗ серверных
// зависимостей: импортируется и движком (сервер), и UI (клиент). Импорт значений
// из движка в клиент утащил бы pg в браузерный бандл (поймано на превью 28.08).

export type EntityKey =
  | 'spb_total' | 'spb_os' | 'spb_nc' | 'spb_nerudka' | 'spb_zhbi' | 'spb_metal'
  | 'msk_total' | 'msk_os' | 'msk_nc' | 'msk_zhbi' | 'krd';

export const ENTITY_DEFS: { key: EntityKey; label: string; city: 'spb' | 'msk' | 'krd'; total?: boolean }[] = [
  { key: 'spb_total', label: 'СПБ ИТОГО', city: 'spb', total: true },
  { key: 'spb_os', label: 'Общестрой СПБ', city: 'spb' },
  { key: 'spb_nc', label: 'Нулевой СПБ', city: 'spb' },
  { key: 'spb_nerudka', label: 'Нерудка СПБ', city: 'spb' },
  { key: 'spb_zhbi', label: 'ЖБИ СПБ', city: 'spb' },
  { key: 'spb_metal', label: 'Металл СПБ', city: 'spb' },
  { key: 'msk_total', label: 'МСК ИТОГО', city: 'msk', total: true },
  { key: 'msk_os', label: 'ОС МСК', city: 'msk' },
  { key: 'msk_nc', label: 'НЦ МСК', city: 'msk' },
  { key: 'msk_zhbi', label: 'ЖБИ МСК', city: 'msk' },
  { key: 'krd', label: 'Краснодар', city: 'krd' },
];

export interface EntityMetrics {
  deals: number;
  salesSum: number;
  shipSum: number;
  /** Первичная конверсия в продажу/отгрузку, доли (0.27). null = знаменатель 0. */
  crSale: number | null;
  crShip: number | null;
  /** Ср. чек = сумма продаж (все) / кол-во продаж (все). */
  avgCheck: number | null;
}

/** План недели/месяца по неденежным метрикам (year_weekly_plans, миграция 166):
 *  deals — месячный ÷ 4 в неделю; конверсии и ср. чек — уровневые, как есть. */
export interface NonMoneyPlan {
  deals: number | null;
  crSale: number | null;
  crShip: number | null;
  avgCheck: number | null;
}

export interface WeekBlock {
  weekStart: string;
  label: string;
  prevWeekStart: string;
  prevLabel: string;
  month: number;
  cur: Record<EntityKey, EntityMetrics>;
  prev: Record<EntityKey, EntityMetrics>;
  planSales: Record<EntityKey, number | null>;
  planShip: Record<EntityKey, number | null>;
  planOther: Record<EntityKey, NonMoneyPlan>;
}

export interface MonthBlock {
  month: number;
  label: string;
  cur: Record<EntityKey, EntityMetrics>;
  prev: Record<EntityKey, EntityMetrics>;
  planSales: Record<EntityKey, number | null>;
  planShip: Record<EntityKey, number | null>;
  planOther: Record<EntityKey, NonMoneyPlan>;
}

export interface YearWeeklyWeatherRow {
  city: 'spb' | 'msk' | 'krd';
  weekStart: string;
  manualText: string | null;
  autoSummary: string | null;
}

export interface YearWeeklyResult {
  year: number;
  entities: typeof ENTITY_DEFS;
  weeks: WeekBlock[];
  months: MonthBlock[];
  weather: YearWeeklyWeatherRow[];
}
