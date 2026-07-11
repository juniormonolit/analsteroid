import { notFound } from 'next/navigation';
import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';
import { MARKETING_PRESETS } from '@/lib/marketing/presets';
import type { SavedReport } from '@/lib/saved-reports/types';
import { defaultPeriod, defaultComparison } from '@/lib/period';

export default async function MarketingPresetPage({
  params,
}: {
  params: Promise<{ preset: string }>;
}) {
  const { preset: key } = await params;
  const p = MARKETING_PRESETS[key];
  if (!p) return notFound();

  // Дефолтный период для этих встроенных пресетов (не «сохранённый отчёт» пользователя,
  // а зашитый в код дефолт) — раньше был periodMode:'relative' {current, month}, который
  // resolveRelativePeriod() кэпает по «сейчас» (сегодня, реальное время сервера), поэтому
  // первая загрузка любого маркетингового отчёта показывала месяц ПО СЕГОДНЯ с неполным
  // текущим днём. Меняем на fixedPeriod = defaultPeriod() (МСК, тот же дефолт, что и у
  // by-managers/by-product-groups без preset) — верхняя граница = вчера. НЕ трогаем
  // resolveRelativePeriod/SaveReportModal: явные Месяц/Квартал/Год и реальные
  // пользовательские сохранённые отчёты (saved/[id]) по-прежнему считаются как раньше.
  // Сравнение — defaultComparison() = recomputeComparison(period): предыдущий период
  // той же длины (задача 1666 — до этого здесь была регрессия f9d69d4, вставлявшая
  // календарный «весь предыдущий месяц», что расходилось с comparisonMode:
  // 'previous_tail' ниже). Календарная семантика (calendarComparisonForPreset)
  // остаётся только для явного клика по быстрой кнопке-пресету в FilterBar.tsx.
  const period = defaultPeriod();
  const comparison = defaultComparison();

  // Синтетический SavedReport: SalesReportPage подхватывает всё из preset-а.
  const preset: SavedReport = {
    id: `marketing:${key}`,
    userLogin: '',
    reportSlug: 'by-sources',
    name: p.title,
    metricIds: p.metricIds,
    dealScope: 'all',
    clientType: 'all',
    grouping: 'none',
    comparisonDisplay: p.comparisonDisplay ?? 'current',
    productGroupMode: 'by_max',
    departmentIds: [],
    metricHighlights: {},
    metricDisplayModes: {},
    comparisonThreshold: 5,
    sourceDimension: p.sourceDimension,
    drilldownDimension: p.drilldownDimension,
    drilldownGrouped: p.drilldownGrouped ?? true,
    periodMode: 'fixed',
    relativePeriod: null,
    comparisonMode: 'previous_tail',
    fixedPeriod: { from: period.from.toISOString(), to: period.to.toISOString() },
    fixedComparison: { from: comparison.from.toISOString(), to: comparison.to.toISOString() },
    createdAt: '',
  };

  return <SalesReportPage reportSlug="by-sources" title={p.title} preset={preset} />;
}
