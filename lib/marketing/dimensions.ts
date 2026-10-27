// Клиентски-безопасный модуль: типы и лейблы маркетинговых измерений.
// Серверная часть (загрузка справочника, SQL) — в lib/marketing/sources.ts.

export type BuiltinSourceDimension = 'brand' | 'platform' | 'contact_type' | 'ad_channel' | 'channel_group' | 'branch' | 'source';
// Группировка из «Ещё → Источники» (миграция 239): ключ `g:<id marketing_groupings>`.
export type CustomSourceDimension = `g:${number}`;
export type SourceDimension = BuiltinSourceDimension | CustomSourceDimension;
export type DrilldownDimension = SourceDimension | 'manager';

export function isCustomDimension(d: string | null | undefined): d is CustomSourceDimension {
  return !!d && /^g:\d+$/.test(d);
}
export function customDimensionId(d: CustomSourceDimension): number {
  return Number(d.slice(2));
}
export const BUILTIN_SOURCE_DIMENSION_KEYS: BuiltinSourceDimension[] = ['brand', 'platform', 'contact_type', 'ad_channel', 'channel_group', 'branch', 'source'];
/** Ключ измерения из URL/тела запроса: встроенный или `g:<id>`; иначе null. */
export function parseSourceDimension(raw: unknown): SourceDimension | null {
  if (typeof raw !== 'string') return null;
  if ((BUILTIN_SOURCE_DIMENSION_KEYS as string[]).includes(raw)) return raw as BuiltinSourceDimension;
  return isCustomDimension(raw) ? raw : null;
}

export const SOURCE_DIMENSIONS: { key: BuiltinSourceDimension; label: string }[] = [
  { key: 'brand',         label: 'Бренд' },
  { key: 'platform',      label: 'Витрина' },
  { key: 'contact_type',  label: 'Контакт' },
  { key: 'channel_group', label: 'Канал (крупно)' },
  { key: 'ad_channel',    label: 'Канал' },
  { key: 'branch',        label: 'Филиал' },
  { key: 'source',        label: 'Источник' },
];

export const DRILLDOWN_DIMENSIONS: { key: BuiltinSourceDimension | 'manager'; label: string }[] = [
  ...SOURCE_DIMENSIONS,
  { key: 'manager', label: 'Менеджеры' },
];

export function dimensionLabel(key: string | undefined): string {
  return DRILLDOWN_DIMENSIONS.find(d => d.key === key)?.label ?? 'Бренд';
}

export const UNDEFINED_LABEL = 'Не определён';
// Источник не разложен ни в одну группу пользовательской группировки.
export const UNASSIGNED_LABEL = 'Не распределено';
export const NO_SOURCE_LABEL = 'Без источника';

// Строка маркетингового отчёта при группировке «По отделам/филиалам» — пара «значение
// измерения × отдел менеджера сделки»: id = `${value}@@${teamId}` (teamId — uuid отдела
// или '__no_team__'). Без группировки id — само значение, как раньше.
export const SOURCE_TEAM_SEP = '@@';
export function splitSourceRowId(id: string): { value: string; teamId: string | null } {
  const i = id.lastIndexOf(SOURCE_TEAM_SEP);
  return i < 0 ? { value: id, teamId: null } : { value: id.slice(0, i), teamId: id.slice(i + SOURCE_TEAM_SEP.length) };
}

