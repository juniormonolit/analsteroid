import type { Metric } from './types';

// Градиент по умолчанию у относительных метрик (п.2 правок 09.07/2). heatmapMetricIds
// (существующее персистентное поле SavedReport, БЕЗ миграции) хранит ТОЛЬКО отклонения
// от дефолта:
//   - обычная запись id      → явное включение (нужно абсолютным метрикам — их дефолт выкл)
//   - запись с префиксом OFF → явное выключение (нужно относительным метрикам — их дефолт вкл)
// Метрики, которых в массиве нет вовсе, живут по дефолту — резолвится на лету
// (isHeatmapEnabled/resolveHeatmapSet), НЕ записывается в конфиг заранее «про запас».
export const HEATMAP_OFF_PREFIX = 'off:';

export function isRelativeDataType(dataType: Metric['dataType'] | null | undefined): boolean {
  return dataType === 'percent';
}

export function isHeatmapEnabled(metricId: string, isRelative: boolean, heatmapMetricIds: string[]): boolean {
  if (heatmapMetricIds.includes(`${HEATMAP_OFF_PREFIX}${metricId}`)) return false;
  if (heatmapMetricIds.includes(metricId)) return true;
  return isRelative;
}

export function resolveHeatmapSet(metrics: Metric[], heatmapMetricIds: string[]): Set<string> {
  const set = new Set<string>();
  for (const m of metrics) {
    if (isHeatmapEnabled(m.id, isRelativeDataType(m.dataType), heatmapMetricIds)) set.add(m.id);
  }
  return set;
}

// Тоггл «Градиент» в панели настроек метрики: пишет в конфиг ТОЛЬКО когда новое
// состояние отличается от дефолта метрики; если пользователь вернул метрику к
// дефолтному поведению — запись убирается целиком (не копим одновременно id и off:id).
export function toggleHeatmap(metricId: string, isRelative: boolean, prev: string[]): string[] {
  const currentlyOn = isHeatmapEnabled(metricId, isRelative, prev);
  const nextOn = !currentlyOn;
  const withoutEntry = prev.filter(id => id !== metricId && id !== `${HEATMAP_OFF_PREFIX}${metricId}`);
  if (nextOn === isRelative) return withoutEntry; // совпадает с дефолтом — запись не нужна
  return [...withoutEntry, nextOn ? metricId : `${HEATMAP_OFF_PREFIX}${metricId}`];
}
