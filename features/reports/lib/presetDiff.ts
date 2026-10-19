import type { SavedReport } from '@/lib/saved-reports/types';

// Плашка расхождения «Вид отличается от сохранённого отчёта» (задача 2881,
// решение владельца: «для такого отчёта выводить надпись где-то вверху... вернуть
// к исходному»). Инцидент-первопричина (#2870, WORKLOG 03.08) — снапшот вкладки
// в localStorage (features/reports/lib/reportTabs.ts) побеждает пресет из БД.
//
// Решение владельца 19.10 (после инцидента «Товары - Менеджеры», 21 группа у
// директора против 64 у супер-админа): плашка реагирует ТОЛЬКО на добавление/
// удаление метрик — сортировка, порядок колонок и оформление её не трогают
// («это немного бесит»). Всё, что определяет ДАННЫЕ (период, срез, группировка,
// фильтр сделок, поиск, фильтры по метрикам/рабочему времени), сравнивать не
// нужно: при открытии сохранённого отчёта оно всегда приводится к сохранённому
// (SalesReportPage → applyPresetData поверх restore вкладки), расхождению там
// неоткуда взяться молча.

/** Набор метрик пресета ТЕМИ ЖЕ правилами, что applyPreset в SalesReportPage:
 * пустой metric_ids в БД означает «все базовые» (all_core). Если это резолвится
 * по-разному в двух местах — сравнение будет врать. */
export function presetMetricIds(preset: SavedReport): string[] {
  return preset.metricIds.length ? preset.metricIds : ['all_core'];
}

/** Человекочитаемые отличия набора метрик от пресета (порядок не важен).
 * Пустой массив — набор совпадает. */
export function diffFromPreset(preset: SavedReport, metricIds: string[]): string[] {
  const base = new Set(presetMetricIds(preset));
  const cur = new Set(metricIds);
  const added = [...cur].filter(id => !base.has(id)).length;
  const removed = [...base].filter(id => !cur.has(id)).length;
  const changed: string[] = [];
  if (added) changed.push(`добавлено метрик: ${added}`);
  if (removed) changed.push(`убрано метрик: ${removed}`);
  return changed;
}
