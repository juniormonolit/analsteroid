// Оценка эффективности обучений — чистые правила (без БД), общие для замера, карточки и сводов.
import type { TaskerVerdict } from '../../types';
import type { TrainingEffectSummary, TrainingOutcome, TrainingResult } from '../types';

/** Окно «до/после» по умолчанию — 7/7 дней (собрание 23.11: «показатели смотрим неделя через неделю»). */
export const DEFAULT_MEASURE_DAYS = 7;

/** YYYY-MM-DD ± дни (UTC-арифметика по календарной дате). */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Календарный день события по Москве. */
export function eventDayMsk(startAt: Date | string): string {
  return new Date(new Date(startAt).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Окна замера: «до» — N дней, закончившихся накануне события; «после» — N дней, начиная со следующего дня.
 * День самого обучения не входит ни туда, ни туда. Замер — с дня после окончания окна «после».
 */
export function trainingWindows(startAt: Date | string, beforeDays: number, afterDays: number) {
  const day = eventDayMsk(startAt);
  const before = { from: addDays(day, -beforeDays), to: addDays(day, -1) };
  const after = { from: addDays(day, 1), to: addDays(day, afterDays) };
  return { before, after, measureFrom: addDays(after.to, 1) };
}

const isGrowth = (v: TaskerVerdict) => v === 'improved' || v === 'achieved';

/**
 * Итог человека по всем его показателям. null — ещё нет ни одного вердикта.
 * Все замеры «мало данных» → мало данных; иначе среди показателей с данными:
 * выросших больше, чем без изменений → вырос, иначе — без изменений (один показатель — его вердикт).
 */
export function personOutcome(results: Pick<TrainingResult, 'verdict'>[]): TrainingOutcome | null {
  const done = results.map(r => r.verdict).filter((v): v is TaskerVerdict => !!v);
  if (done.length === 0) return null;
  const withData = done.filter(v => v !== 'not_enough_data');
  if (withData.length === 0) return 'not_enough_data';
  const up = withData.filter(isGrowth).length;
  return up > withData.length - up ? 'improved' : 'no_change';
}

/** Сводка карточки события по видимым людям. */
export function summarize(
  people: { attended: boolean | null; outcome: TrainingOutcome | null; resultsComplete: boolean; measurable: boolean }[],
  measureFrom: string,
): TrainingEffectSummary {
  const s: TrainingEffectSummary = {
    attended: 0, absent: 0, unmarked: 0, improved: 0, noChange: 0, notEnoughData: 0, pending: 0, measureFrom,
  };
  for (const p of people) {
    if (p.attended === null) { s.unmarked++; continue; }
    if (!p.attended) { s.absent++; continue; }
    s.attended++;
    if (!p.measurable) continue; // нечего замерять: ни показателей события, ни цели
    if (!p.resultsComplete || !p.outcome) s.pending++;
    else if (p.outcome === 'improved') s.improved++;
    else if (p.outcome === 'no_change') s.noChange++;
    else s.notEnoughData++;
  }
  return s;
}

/** Показатели, которые замеряются у человека: показатели события ∪ цели записи ∪ показатель задачи. */
export function personMetricIds(eventMetricIds: string[], goalMetricIds: string[], taskMetricId: string | null): string[] {
  return [...new Set([...eventMetricIds, ...goalMetricIds, ...(taskMetricId ? [taskMetricId] : [])])];
}
