// Конструктор наград, этап 2: параметризуемые шаблоны критериев (НЕ произвольные
// формулы). Кастомное определение живёт в badge_definitions с key `custom_…` и
// criteria.template = тип шаблона; исполняется теми же generic-исполнителями в
// runBadgeRecompute. Чистый модуль (без pg) — используется сервером и UI-формой.

export const CUSTOM_PREFIX = 'custom_';

export type CustomMetric = 'sales_amount' | 'sales_count' | 'shipments_amount' | 'repeat_sales_count';
export type CustomPeriod = 'day' | 'week' | 'month' | 'year';
export type MilestoneKind = 'sales_count' | 'sales_amount' | 'deal_amount';
export type CustomTemplate = 'top_metric' | 'threshold_period' | 'crosssell_pair' | 'streak' | 'milestone' | 'daily_bonus';

// Метрики дня для «Ежедневного бонуса» (доп. Серёги 31.07): счётчики/суммы событий
// дня менеджера; bookings_plus_sales_count — составная (брони reserved_at +
// продажи sold_at за день).
export type DailyBonusMetric =
  | 'sales_count' | 'sales_amount' | 'bookings_count' | 'shipments_count' | 'shipments_amount'
  | 'bookings_plus_sales_count';

export const DAILY_BONUS_METRIC_LABELS: Record<DailyBonusMetric, string> = {
  bookings_plus_sales_count: 'Брони + продажи за день, шт',
  sales_count: 'Продажи за день, шт',
  sales_amount: 'Сумма продаж за день, ₽',
  bookings_count: 'Брони за день, шт',
  shipments_count: 'Отгрузки за день, шт',
  shipments_amount: 'Сумма отгрузок за день, ₽',
};

export const METRIC_LABELS: Record<CustomMetric, string> = {
  sales_amount: 'Сумма продаж',
  sales_count: 'Количество продаж',
  shipments_amount: 'Сумма отгрузок',
  repeat_sales_count: 'Количество повторных продаж',
};

export const CUSTOM_PERIOD_LABELS: Record<CustomPeriod, string> = {
  day: 'День', week: 'Неделя', month: 'Месяц', year: 'Год',
};

const PERIOD_GENITIVE: Record<CustomPeriod, string> = {
  day: 'за день', week: 'за неделю', month: 'за месяц', year: 'за год',
};

export const MILESTONE_KIND_LABELS: Record<MilestoneKind, string> = {
  sales_count: 'Всего продаж, шт',
  sales_amount: 'Сумма продаж за всё время, ₽',
  deal_amount: 'Чек одной сделки от, ₽',
};

export const TEMPLATE_LABELS: Record<CustomTemplate, { name: string; hint: string }> = {
  top_metric: {
    name: 'Топ по метрике за период',
    hint: 'Лучший результат по выбранной метрике за завершённый период. Уровневая — бронза/серебро/золото/платина по масштабу победы (отдел/департамент/филиал/страна), или одноуровневая (лучший по всей стране).',
  },
  threshold_period: {
    name: 'Порог за период',
    hint: 'Метрика за период достигла порога — например, «продал за день на 500 000+». Награда за каждый такой завершённый период.',
  },
  crosssell_pair: {
    name: 'Кросс-селл пара',
    hint: 'Клиент купил товар группы X, а следующей сделкой ему допродали группу Y. Счётчик пар; награда появляется при достижении минимума.',
  },
  streak: {
    name: 'Серия',
    hint: 'N рабочих дней подряд хотя бы с одной продажей (по производственному календарю РФ).',
  },
  milestone: {
    name: 'Веха',
    hint: 'Накопительный порог за всё время: всего продаж / сумма продаж / чек одной сделки не ниже X.',
  },
  daily_bonus: {
    name: 'Ежедневный бонус',
    hint: 'Автопоощрение валютой за каждый день, где метрика дня достигла порога (например, «брони + продажи ≥ 5»). Начисляется ночным прогоном, идемпотентно. Можно сделать «тихим»: только выписка и баланс, без бейджа на полке.',
  },
};

export interface CustomCriteria {
  template: CustomTemplate;
  // top_metric / threshold_period
  metric?: CustomMetric;
  period?: CustomPeriod;
  tieredScopes?: boolean;   // top_metric: уровни по масштабу победы
  threshold?: number;       // threshold_period / milestone
  // crosssell_pair
  firstGroup?: string;
  nextGroup?: string;
  minPairs?: number;
  // streak
  days?: number;
  // milestone
  kind?: MilestoneKind;
  // daily_bonus
  dailyMetric?: DailyBonusMetric;
  silent?: boolean;        // тихое начисление: только выписка и баланс, без бейджа на полке
  // Задел под индексацию магазина: опциональная «сумма в единицах индекса» —
  // пока НЕ активна, включится с магазинной индексацией
  // (см. owners-inbox/monolitika-eball-indexation.md в life-os).
  indexUnits?: number;
}

const METRICS = Object.keys(METRIC_LABELS) as CustomMetric[];
const PERIODS = Object.keys(CUSTOM_PERIOD_LABELS) as CustomPeriod[];
const KINDS = Object.keys(MILESTONE_KIND_LABELS) as MilestoneKind[];

function posInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function posNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// Валидация критериев шаблона (сервер И клиент). Возвращает НОРМАЛИЗОВАННЫЙ
// объект criteria (только известные поля шаблона — мусор отбрасывается).
export function validateCustomCriteria(raw: unknown): { ok: true; criteria: CustomCriteria } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'criteria: объект' };
  }
  const c = raw as Record<string, unknown>;
  const template = c.template as CustomTemplate;
  if (!TEMPLATE_LABELS[template]) return { ok: false, error: 'Неизвестный шаблон' };

  switch (template) {
    case 'top_metric': {
      if (!METRICS.includes(c.metric as CustomMetric)) return { ok: false, error: 'Выберите метрику' };
      if (!PERIODS.includes(c.period as CustomPeriod)) return { ok: false, error: 'Выберите период' };
      return { ok: true, criteria: { template, metric: c.metric as CustomMetric, period: c.period as CustomPeriod, tieredScopes: c.tieredScopes === true } };
    }
    case 'threshold_period': {
      if (!METRICS.includes(c.metric as CustomMetric)) return { ok: false, error: 'Выберите метрику' };
      if (!PERIODS.includes(c.period as CustomPeriod)) return { ok: false, error: 'Выберите период' };
      if (!posNum(c.threshold)) return { ok: false, error: 'Порог должен быть больше нуля' };
      return { ok: true, criteria: { template, metric: c.metric as CustomMetric, period: c.period as CustomPeriod, threshold: c.threshold } };
    }
    case 'crosssell_pair': {
      const first = typeof c.firstGroup === 'string' ? c.firstGroup.trim() : '';
      const next = typeof c.nextGroup === 'string' ? c.nextGroup.trim() : '';
      if (!first || !next) return { ok: false, error: 'Выберите обе товарные группы' };
      if (first === next) return { ok: false, error: 'Группы X и Y должны отличаться' };
      if (!posInt(c.minPairs)) return { ok: false, error: 'Минимум пар — целое число больше нуля' };
      return { ok: true, criteria: { template, firstGroup: first, nextGroup: next, minPairs: c.minPairs } };
    }
    case 'streak': {
      if (!posInt(c.days)) return { ok: false, error: 'Длина серии — целое число больше нуля' };
      return { ok: true, criteria: { template, days: c.days } };
    }
    case 'milestone': {
      if (!KINDS.includes(c.kind as MilestoneKind)) return { ok: false, error: 'Выберите вид вехи' };
      if (!posNum(c.threshold)) return { ok: false, error: 'Порог должен быть больше нуля' };
      return { ok: true, criteria: { template, kind: c.kind as MilestoneKind, threshold: c.threshold } };
    }
    case 'daily_bonus': {
      if (!Object.keys(DAILY_BONUS_METRIC_LABELS).includes(c.dailyMetric as string)) {
        return { ok: false, error: 'Выберите метрику дня' };
      }
      if (!posNum(c.threshold)) return { ok: false, error: 'Порог должен быть больше нуля' };
      const out: CustomCriteria = {
        template, dailyMetric: c.dailyMetric as DailyBonusMetric, threshold: c.threshold,
        silent: c.silent === true,
      };
      if (typeof c.indexUnits === 'number' && Number.isFinite(c.indexUnits) && c.indexUnits > 0) {
        out.indexUnits = c.indexUnits; // задел индексации, пока не активен
      }
      return { ok: true, criteria: out };
    }
  }
}

const fmt = (n: number) => n.toLocaleString('ru-RU');

// Автоописание для каталога/полки, если создатель не написал своё.
export function describeCustom(c: CustomCriteria): string {
  switch (c.template) {
    case 'top_metric':
      return `${METRIC_LABELS[c.metric!]} — лучший результат ${PERIOD_GENITIVE[c.period!]}.` +
        (c.tieredScopes ? ' Бронза — лучший в отделе, серебро — в департаменте, золото — в филиале, платина — в стране.' : ' Лучший по всей стране.');
    case 'threshold_period':
      return `${METRIC_LABELS[c.metric!]} ${PERIOD_GENITIVE[c.period!]} — ${fmt(c.threshold!)} и больше. Награда за каждый такой период.`;
    case 'crosssell_pair':
      return `Клиент купил «${c.firstGroup}», а следующей сделкой вы допродали ему «${c.nextGroup}» (от ${fmt(c.minPairs!)} пар). Счётчик растёт с каждой парой.`;
    case 'streak':
      return `${fmt(c.days!)} рабочих дней подряд хотя бы с одной продажей (по производственному календарю РФ).`;
    case 'milestone':
      return `${MILESTONE_KIND_LABELS[c.kind!]}: порог ${fmt(c.threshold!)} за всё время.`;
    case 'daily_bonus':
      return `Ежедневный бонус: ${DAILY_BONUS_METRIC_LABELS[c.dailyMetric!]} — от ${fmt(c.threshold!)}. Начисляется за каждый день выполнения.`;
  }
}
