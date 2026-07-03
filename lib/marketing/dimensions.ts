// Клиентски-безопасный модуль: типы и лейблы маркетинговых измерений.
// Серверная часть (загрузка справочника, SQL) — в lib/marketing/sources.ts.

export type SourceDimension = 'brand' | 'platform' | 'contact_type' | 'ad_channel' | 'channel_group' | 'branch' | 'source';
export type DrilldownDimension = SourceDimension | 'manager';

export const SOURCE_DIMENSIONS: { key: SourceDimension; label: string }[] = [
  { key: 'brand',         label: 'Бренд' },
  { key: 'platform',      label: 'Витрина' },
  { key: 'contact_type',  label: 'Контакт' },
  { key: 'channel_group', label: 'Канал (крупно)' },
  { key: 'ad_channel',    label: 'Канал' },
  { key: 'branch',        label: 'Филиал' },
  { key: 'source',        label: 'Источник' },
];

export const DRILLDOWN_DIMENSIONS: { key: DrilldownDimension; label: string }[] = [
  ...SOURCE_DIMENSIONS,
  { key: 'manager', label: 'Менеджеры' },
];

export function dimensionLabel(key: string | undefined): string {
  return DRILLDOWN_DIMENSIONS.find(d => d.key === key)?.label ?? 'Бренд';
}

export const UNDEFINED_LABEL = 'Не определён';
export const NO_SOURCE_LABEL = 'Без источника';
