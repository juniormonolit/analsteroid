import type { MetricHighlightConfig } from '@/lib/saved-reports/types';

// Фильтр/сортировка по метрике (панель настроек метрики → «Фильтр и сортировка»,
// правка владельца 09.07): чисто клиентское, сессионное состояние (см. ReportTable/
// SalesReportPage) — НЕ персистится в SavedReport, поэтому живёт вне lib/saved-reports/types.ts.

export type ConditionOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between';

export interface MetricConditionFilter {
  op: ConditionOp;
  value: number;
  value2?: number; // только для 'between'
}

export interface MetricFilterState {
  // ключ зоны цвета: для градиента — 'red'|'yellow'|'green', для порогов — '0'..'N-1'|'above'.
  // null/undefined = «все» (фильтр по цвету не активен).
  colorZone?: string | null;
  condition?: MetricConditionFilter | null;
  // Сортировать строки по цветовой зоне метрики (лучшая зона сверху). Только одна
  // метрика может «сортировать по цвету» одновременно — см. SalesReportPage.
  sortByColor?: boolean;
}

export type MetricFilters = Record<string, MetricFilterState>;

export const CONDITION_OPTIONS: { value: ConditionOp; label: string }[] = [
  { value: 'gt',      label: 'больше' },
  { value: 'gte',     label: 'больше или равно' },
  { value: 'lt',      label: 'меньше' },
  { value: 'lte',     label: 'меньше или равно' },
  { value: 'eq',      label: 'равно' },
  { value: 'neq',     label: 'не равно' },
  { value: 'between', label: 'между' },
];

export function matchesCondition(value: number | null, cond: MetricConditionFilter | null | undefined): boolean {
  if (!cond) return true;
  if (value === null) return false;
  switch (cond.op) {
    case 'gt':  return value > cond.value;
    case 'gte': return value >= cond.value;
    case 'lt':  return value < cond.value;
    case 'lte': return value <= cond.value;
    case 'eq':  return value === cond.value;
    case 'neq': return value !== cond.value;
    case 'between': {
      const lo = Math.min(cond.value, cond.value2 ?? cond.value);
      const hi = Math.max(cond.value, cond.value2 ?? cond.value);
      return value >= lo && value <= hi;
    }
    default: return true;
  }
}

// ── Цветовые зоны ───────────────────────────────────────────────────────────────
// Общая «зона» значения — используется и фильтром по цвету (#1), и сортировкой по
// цвету (#3). rank: 0 = лучшая зона (сверху при сортировке «по цвету»).
export interface ZoneInfo {
  key: string;
  color: string;
  rank: number;
}

// Пороговый режим: зоны — ЯВНЫЕ интервалы между порогами (не плавный градиент
// resolveHighlightColor в ReportTable.tsx — там для ОТОБРАЖЕНИЯ цвет интерполируется
// между соседними точками; здесь для фильтра/сортировки нужна чёткая, дискретная
// принадлежность к одному из N+1 «карманов»). Границы карманов = сами значения порогов.
// rank считается «от aboveColor вниз»: above=0 (лучшая), последний порог=1, ...,
// первый карман (индекс 0) = N (худшая) — см. бриф владельца п.3.
export function resolveThresholdZone(value: number | null, cfg: MetricHighlightConfig | undefined): ZoneInfo | null {
  if (!cfg?.enabled || value === null) return null;
  const sorted = [...cfg.thresholds].sort((a, b) => a.value - b.value);
  if (!sorted.length) return { key: 'above', color: cfg.aboveColor, rank: 0 };
  if (value <= sorted[0].value) {
    return { key: '0', color: sorted[0].color, rank: sorted.length };
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    if (value <= sorted[i + 1].value) {
      return { key: String(i + 1), color: sorted[i + 1].color, rank: sorted.length - (i + 1) };
    }
  }
  return { key: 'above', color: cfg.aboveColor, rank: 0 };
}

// Свотчи для UI (панель настроек метрики): цвета порогов в порядке возрастания + aboveColor.
export function thresholdZoneSwatches(cfg: { thresholds: { value: number; color: string }[]; aboveColor: string } | null | undefined): { key: string; color: string }[] {
  if (!cfg) return [];
  const sorted = [...cfg.thresholds].sort((a, b) => a.value - b.value);
  return [
    ...sorted.map((t, i) => ({ key: String(i), color: t.color })),
    { key: 'above', color: cfg.aboveColor },
  ];
}

// Режим «Градиент» (heatColor в ReportTable.tsx): цвет непрерывный, hsl(t*120, 70%, 50%)
// по РАНГОВОМУ t (0..1, уже с учётом инверсии heatmapInvertedIds — см. вызывающую сторону).
// Квантование к ближайшему из 3 опорных цветов шкалы (красный t=0 / жёлтый t=0.5 /
// зелёный t=1): граница ровно посередине между соседними опорными точками — t=0.25 и t=0.75.
// Пример владельца (7 значений между зелёным и жёлтым → 4 зелёных, 3 жёлтых) выполняется
// автоматически: t делит диапазон поровну, «зелёная» зона шире к границе 0.75 включительно.
export const GRADIENT_ZONE_COLOR: Record<'red' | 'yellow' | 'green', string> = {
  red:    'hsl(0 70% 50%)',
  yellow: 'hsl(60 70% 50%)',
  green:  'hsl(120 70% 50%)',
};
export const GRADIENT_ZONE_SWATCHES: { key: 'green' | 'yellow' | 'red'; color: string; label: string }[] = [
  { key: 'green',  color: GRADIENT_ZONE_COLOR.green,  label: 'Зелёная' },
  { key: 'yellow', color: GRADIENT_ZONE_COLOR.yellow, label: 'Жёлтая' },
  { key: 'red',    color: GRADIENT_ZONE_COLOR.red,    label: 'Красная' },
];

export function gradientZoneFromRank(t: number): ZoneInfo {
  if (t >= 0.75) return { key: 'green',  color: GRADIENT_ZONE_COLOR.green,  rank: 0 };
  if (t < 0.25)  return { key: 'red',    color: GRADIENT_ZONE_COLOR.red,    rank: 2 };
  return           { key: 'yellow', color: GRADIENT_ZONE_COLOR.yellow, rank: 1 };
}
