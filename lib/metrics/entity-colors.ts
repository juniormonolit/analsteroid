// Автоцвет метрики по СУЩНОСТИ (задача 6а, п.10 согласованной спеки 2026-07-08:
// owners-inbox/analsteroid-edits-spec-agreed-20260708.md).
//
// Приоритет цвета метрики (см. lib/metrics/catalog.ts loadMetrics):
//   1. Ручное переопределение по метрике   (metric_colors, scope='metric')
//   2. Ручное переопределение по категории (metric_colors, scope='category')
//   3. Автоцвет по сущности — ЭТОТ ФАЙЛ, код, не БД
//   4. null — «Сделки»/«Необработанные»: сознательно БЕЗ цвета (белый),
//      либо серый фолбэк — если сущность метрики не удалось определить вовсе.
//
// Смысловой градиент брони → продажа: голубой → светло-синий → синий.
// Конверсии (CR X→Y) и метрики планов красятся по ЧИСЛИТЕЛЮ/сущности результата,
// не по факту принадлежности к категории «Конверсии»/«Планы» самой по себе.

export const ENTITY_COLOR = {
  reservation: '#93c5fd', // Брони — голубой
  reservationConfirmed: '#60a5fa', // Подтв. брони — светло-синий (шаг градиента к синему)
  sale: '#3b82f6', // Продажи — синий
  shipment: '#22c55e', // Отгрузки — зелёный
  refusal: '#ef4444', // Отказы — красный
  call: '#eab308', // Звонки — жёлтый (категории «Звонки» в каталоге пока нет — задел на будущее)
  activity: '#8b5cf6', // Активность менеджеров (Дней в работе/% выхода/Сделок в день) — фиолетовый, отдельно от воронки
  neutral: null as string | null, // Сделки / «Необработанные» — белый, без окраски (сознательно)
  unknown: '#94a3b8', // Не удалось определить сущность — серый (нейтральный фолбэк)
} as const;

export type EntityKey = keyof typeof ENTITY_COLOR;

export interface AutoColorInput {
  id: string;
  category?: string | null;
  nameRu?: string | null;
}

// Порядок ВАЖЕН (первое совпадение побеждает): более специфичные признаки раньше
// более общих, например «lost» проверяется раньше «sale»/«shipment» и т.п.
const ENTITY_PATTERNS: Array<[RegExp, EntityKey]> = [
  [/lost|отказ/i, 'refusal'],
  [/shipment|отгруз/i, 'shipment'],
  [/confirm|подтв/i, 'reservationConfirmed'],
  [/reservation|брон/i, 'reservation'],
  [/sale|продаж/i, 'sale'],
  [/call|созвон|звон/i, 'call'],
  [/repeat_created|deal|сделк/i, 'neutral'],
];

function entityFromText(text: string): EntityKey | null {
  for (const [re, key] of ENTITY_PATTERNS) {
    if (re.test(text)) return key;
  }
  return null;
}

// Извлекает сущность-числитель из id конверсии вида "..._to_<entity>[_primary|_repeat|_all]".
function entityFromCrId(id: string): EntityKey | null {
  const m = id.match(/_to_([a-z_]+?)(?:_(?:primary|repeat|all))?$/i);
  if (!m) return null;
  return entityFromText(m[1]);
}

/**
 * Автоцвет метрики по её сущности. Всегда возвращает значение (либо цвет,
 * либо null для сознательно-нейтральных «Сделки»/«Необработанные» — 100% покрытие
 * каталога, серый — конечный фолбэк для того, что не удалось классифицировать).
 */
export function resolveAutoColor(metric: AutoColorInput): string | null {
  const category = metric.category ?? '';
  const id = metric.id ?? '';
  const name = metric.nameRu ?? '';

  switch (category) {
    case 'Отказы':
      return ENTITY_COLOR.refusal;
    case 'Продажи':
      return ENTITY_COLOR.sale;
    case 'Отгрузки':
      return ENTITY_COLOR.shipment;
    case 'Звонки': // категории в каталоге пока нет — задел на будущее (см. п.10 спеки)
      return ENTITY_COLOR.call;
    case 'Активность': // Дней в работе / % выхода / Сделок в день (спека 10.07)
      return ENTITY_COLOR.activity;
    case 'Сделки':
      return ENTITY_COLOR.neutral;
    case 'Брони': {
      // Подтверждённые брони — отдельный, более тёмный шаг градиента к «синему».
      const confirmed = /confirm|подтв/i.test(id) || /подтв/i.test(name);
      return confirmed ? ENTITY_COLOR.reservationConfirmed : ENTITY_COLOR.reservation;
    }
    case 'Конверсии':
    case 'Конверсии стадий': {
      // Цвет CR — по ЧИСЛИТЕЛЮ (правая часть "X → Y" в id/названии), не по категории.
      // «Конверсии стадий» (миграция 064, переходы по sa.deal_events) красится тем же
      // правилом — id визуально оканчивается на "_to_<entity>[_repeat|_all]" (см.
      // entityFromCrId); промежуточные шаги без узнаваемой сущности (taken/contacted/
      // priced) уходят в серый фолбэк — ok, они не про Брони/Продажи/Отгрузки/Отказы.
      const key = entityFromCrId(id) ?? entityFromText(name) ?? entityFromText(id);
      return key ? ENTITY_COLOR[key] : ENTITY_COLOR.unknown;
    }
    case 'Планы': {
      // Метрики выполнения плана продаж/отгрузок (задача 5) — по сущности числителя.
      const key = entityFromText(id) ?? entityFromText(name);
      return key ? ENTITY_COLOR[key] : ENTITY_COLOR.unknown;
    }
    default: {
      // Прочее + технический долг: legacy id из ранних миграций (006/009) с
      // category='cr'/'avg'/'primary'/'repeat' (нижний регистр, не переименованы
      // миграцией 041) — пытаемся определить сущность по id/названию,
      // иначе — серый фолбэк.
      const key = entityFromText(id) ?? entityFromText(name);
      return key ? ENTITY_COLOR[key] : ENTITY_COLOR.unknown;
    }
  }
}

export type CategoryColorPreview =
  | { kind: 'color'; color: string } // единый автоцвет для всей категории
  | { kind: 'neutral' } // сознательно без цвета (Сделки)
  | { kind: 'mixed' }; // цвет зависит от конкретной метрики (Конверсии/Планы)

/**
 * Представительный автоцвет ЦЕЛОЙ категории (для превью в /settings/metric-colors,
 * когда для категории ещё нет ручного переопределения). 'mixed' — категория
 * неоднородна по цвету (Конверсии/Планы красятся per-metric, по числителю) —
 * в этом случае UI должен показать «авто по метрике», а не один цветной кружок.
 */
export function categoryDefaultColor(category: string): CategoryColorPreview {
  if (category === 'Конверсии' || category === 'Конверсии стадий' || category === 'Планы') return { kind: 'mixed' };
  const color = resolveAutoColor({ id: '', category, nameRu: '' });
  return color ? { kind: 'color', color } : { kind: 'neutral' };
}
