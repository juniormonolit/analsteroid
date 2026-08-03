import type { SavedReport } from '@/lib/saved-reports/types';
import type { DealScope, ClientType, Grouping, ComparisonDisplay, ProductGroupMode, AccountType } from '@/lib/metrics/types';

// Плашка расхождения «Вид изменён относительно сохранённого отчёта» (задача 2881,
// решение владельца: «для такого отчёта выводить надпись где-то вверху... вернуть
// к исходному»). Инцидент-первопричина (#2870, WORKLOG 03.08) — снапшот вкладки
// в localStorage (features/reports/lib/reportTabs.ts) побеждает пресет из БД на
// каждом монтировании по замыслу («настроил и вернулся»), и пользователь не
// понимал, ПОЧЕМУ у него отчёт не такой, как сохранён. Эта плашка делает
// расхождение видимым и даёт кнопку возврата — не убирает сам механизм вкладок.

/** Поля, которые реально определяют «какой это отчёт» — та же граница, что уже
 * проведена в SalesReportPage/DESIGN_GUIDELINES.md для useUrlState (набор
 * метрик/срез/группировка/сортировка), НЕ формат-настройки просмотра (зебра,
 * границы, подсветки, decimal-переопределения и т.п. — персональные настройки
 * показа, не «другой отчёт»). Период/сравнение сознательно исключены: для
 * relative-пресетов они резолвятся от «сейчас» при каждом монтировании
 * (resolveRelativePeriod), сравнение с уже открытым состоянием почти всегда
 * ложно-положительно совпадало бы «различается» без реального действия
 * пользователя. Сессионные поля (metricFilters/createdTime/firstTouch/search) —
 * в SavedReport вообще не персистятся, сравнивать не с чем. */
export interface ReportIdentityView {
  metricIds: string[];
  dealScope: DealScope;
  clientType: ClientType;
  grouping: Grouping;
  comparisonDisplay: ComparisonDisplay;
  productGroupMode: ProductGroupMode;
  accountType: AccountType;
  sourceDimension: string;
  sortBy: string | null;
  sortDir: 'asc' | 'desc';
}

const FIELD_LABELS = {
  metricIds: 'набор метрик',
  dealScope: 'срез сделок',
  clientType: 'тип клиента',
  grouping: 'группировка',
  comparisonDisplay: 'вид сравнения',
  productGroupMode: 'группировка товаров',
  accountType: 'тип аккаунтов',
  sourceDimension: 'разрез источников',
  sort: 'сортировка',
} as const;

function sameOrderedList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Резолвит «идентичность» пресета ТЕМИ ЖЕ правилами, что применяющий эффект в
 * SalesReportPage (applyPreset) — metricIds пустой в БД означает «все базовые»
 * (all_core), accountType/sourceDimension/sortBy/sortDir по умолчанию. Если это
 * резолвится по-разному в двух местах — сравнение будет врать, поэтому здесь
 * ровно та же логика, что и при applyPreset. */
export function presetIdentity(preset: SavedReport): ReportIdentityView {
  return {
    metricIds: preset.metricIds.length ? preset.metricIds : ['all_core'],
    dealScope: preset.dealScope,
    clientType: preset.clientType,
    grouping: preset.grouping,
    comparisonDisplay: preset.comparisonDisplay,
    productGroupMode: preset.productGroupMode,
    accountType: preset.accountType ?? 'managers',
    sourceDimension: preset.sourceDimension ?? 'brand',
    sortBy: preset.sortBy ?? null,
    sortDir: preset.sortDir ?? 'desc',
  };
}

/** Список человекочитаемых меток полей, отличающихся от пресета. Пустой массив —
 * вид совпадает с сохранённым (или сравнивать не с чем — см. вызывающую сторону:
 * плашка не должна показываться для встроенных пресетов без реального
 * сохранённого отчёта в БД). */
export function diffFromPreset(preset: SavedReport, current: ReportIdentityView): string[] {
  const base = presetIdentity(preset);
  const changed: string[] = [];
  if (!sameOrderedList(base.metricIds, current.metricIds)) changed.push(FIELD_LABELS.metricIds);
  if (base.dealScope !== current.dealScope) changed.push(FIELD_LABELS.dealScope);
  if (base.clientType !== current.clientType) changed.push(FIELD_LABELS.clientType);
  if (base.grouping !== current.grouping) changed.push(FIELD_LABELS.grouping);
  if (base.comparisonDisplay !== current.comparisonDisplay) changed.push(FIELD_LABELS.comparisonDisplay);
  if (base.productGroupMode !== current.productGroupMode) changed.push(FIELD_LABELS.productGroupMode);
  if (base.accountType !== current.accountType) changed.push(FIELD_LABELS.accountType);
  if (base.sourceDimension !== current.sourceDimension) changed.push(FIELD_LABELS.sourceDimension);
  if (base.sortBy !== current.sortBy || base.sortDir !== current.sortDir) changed.push(FIELD_LABELS.sort);
  return changed;
}
