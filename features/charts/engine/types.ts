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

// Пятый график, ВЕРСИЯ 2 (задача 2574, владелец 30.07, дословно: «показывать
// не только продажу, но и бронь/отгрузку... на какой день конверсия в
// бронь/продажу/отгрузку настолько ничтожна, чтобы не париться»). Три линии
// вместо одной (reserved/sold/shipped) поверх ТОЙ ЖЕ когорты и той же шкалы
// дней (работа без reserved/confirmed), что версия 1 — серые столбики
// «дожили минимум N дней» общие на все три линии, каждая линия — своё
// событие «ушла ровно на день N» (d.reserved_at / d.sold_at / d.delivered_at
// на сделке). ВАЖНО: одна и та же сделка обычно проходит бронь → продажу →
// отгрузку в разные дни, поэтому попадает в разные линии на разных точках —
// сумма трёх линий НЕ равна когорте и линии друг из друга не вычитаются.
export interface MilestoneCohortPoint {
  day: number;              // 0..30, затем один агрегированный «31+» с day=31
  label: string;             // «0» … «30», «31+»
  cohort: number;             // «дожили» минимум day дней (та же для всех трёх линий)
  reserved: number;           // ушли в бронь (reserved_at) ровно на этот день
  sold: number;                // ушли в продажу (sold_at) ровно на этот день
  shipped: number;             // ушли в отгрузку (delivered_at) ровно на этот день
}

export interface MilestoneCohortResult {
  points: MilestoneCohortPoint[];
  cohortTotal: number;
  reservedTotal: number;
  soldTotal: number;
  shippedTotal: number;
}
