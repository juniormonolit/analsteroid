// Общие типы кривой выживаемости — отдельно от stageSurvival.ts, чтобы клиентские
// компоненты импортировали типы, не таща серверный модуль с db-клиентом.
export type SurvivalPreset = 'priced' | 'work';

export interface SurvivalBucket {
  label: string;      // «0», «1», … «14–20», «30+»
  daysFrom: number;   // включительно
  total: number;      // сделок в корзине
  sold: number;       // из них продано (sold_at >= первого входа)
  pct: number | null; // sold/total*100, null при total=0
}

export interface SurvivalResult {
  buckets: SurvivalBucket[];
  cohortTotal: number;
  soldTotal: number;
  overallPct: number | null;
  stillInStage: number; // сделки без «выхода» — их дни растут до сих пор
}
