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

// Когорта «Созвонился → продажа по дням» (задача 2533, владелец 29.07): таблица
// дожития — на какой день СЧИТАЯ ОТ ВХОДА в стадию «Созвонился и озвучил цены»
// случается продажа (не день выхода из стадии — это другая величина, см.
// SurvivalBucket выше). Право-цензурировано: непроданные сделки остаются в
// cohort, пока наблюдались минимум N дней.
export interface CalledToSaleCohortPoint {
  day: number;         // 0..30, затем один агрегированный «31+» с day=31
  label: string;       // «0» … «30», «31+»
  cohort: number;      // «дожили» минимум day дней, не продав раньше (at risk)
  sold: number;        // продали ровно на этот день
  pct: number | null;  // sold/cohort*100, null при cohort=0
}

export interface CalledToSaleCohortResult {
  points: CalledToSaleCohortPoint[];
  cohortTotal: number;   // = points[0].cohort — вся когорта, вошедшая в период
  soldTotal: number;     // Σ sold по всем точкам
  overallPct: number | null;
}
