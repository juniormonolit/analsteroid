import type { Metric } from './types';

// Строка «формула расчёта» для «?» у метрики (правка владельца 17.08) — БЕЗ
// серверных импортов: используется в клиентских попапах (MetricPanel, шапка
// колонки ReportTable).
//
// calculated — готовая formulaHuman из каталога (русские названия, × ÷);
// collected  — компактная тех-строка из определения: агрегат(поле) · окно · фильтры;
// external   — null (движок в коде, формулы как строки не существует — человеческое
// описание уже говорит как считается).
export function metricFormulaLine(m: Metric): string | null {
  if (m.metricType === 'calculated') return m.formulaHuman ?? m.formula ?? null;
  if (m.metricType === 'collected') {
    const agg = `${m.aggFn ?? 'count_distinct'}(${m.aggField ?? 'deal_id'})`;
    const win = m.dateField ? ` · окно: ${m.dateField}` : '';
    const filters = (m.filters ?? [])
      .map(f => `${f.field} ${f.op}${f.value !== '' && f.value != null ? ` ${Array.isArray(f.value) ? f.value.join(',') : f.value}` : ''}`)
      .join('; ');
    return `${agg}${win}${filters ? ` · фильтры: ${filters}` : ''}`;
  }
  return null;
}
