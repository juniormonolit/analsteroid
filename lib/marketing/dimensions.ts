// Клиентски-безопасный модуль: типы и лейблы маркетинговых измерений.
// Серверная часть (загрузка справочника, SQL) — в lib/marketing/sources.ts.

// 'department' и 'product_group' (владелец/маркетолог 11.11: «отдел», «сколько сделок по газобетону
// пришло с авито») — не про источник, а про менеджера сделки и её товарную группу (головная группа,
// как «по наибольшей» в основном отчёте); в маркетинговых отчётах они такие же разрезы, как «Филиал».
export type BuiltinSourceDimension = 'brand' | 'platform' | 'contact_type' | 'ad_channel' | 'channel_group' | 'branch' | 'source' | 'department' | 'product_group';
/** Разрезы, которые считаются по менеджеру сделки, а не по source_id. */
export const MANAGER_DIMENSIONS: readonly string[] = ['branch', 'department'];
/** Разрезы не по источнику (менеджер / товарная группа): фильтр по ним — всегда SQL. */
export function isNonSourceDimension(d: string | null | undefined): boolean {
  return d === 'branch' || d === 'department' || d === 'product_group';
}
export const NO_PRODUCT_GROUP_LABEL = 'Без группы';
export const NO_TEAM_LABEL = 'Без отдела';
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
export const BUILTIN_SOURCE_DIMENSION_KEYS: BuiltinSourceDimension[] = ['brand', 'platform', 'contact_type', 'ad_channel', 'channel_group', 'branch', 'source', 'department', 'product_group'];
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
  { key: 'department',    label: 'Отдел' },
  { key: 'product_group', label: 'Товарная группа' },
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

