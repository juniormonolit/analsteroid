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
  // Разбивка проданных ЭТОГО дня по товарным группам «Категории КЦ» (задача
  // 2599, владелец 30.07: «в тултипе при наведении показывались данные с
  // разбивкой по товарным группам по кц»). Заполняется ТОЛЬКО пятым графиком
  // (workExclReservedCohort.ts): топ-5 групп + «Прочие (k)»; Σ count = sold
  // точки. У 3-го/4-го графиков поля нет — тултип рисует блок по наличию.
  groups?: KcGroupSlice[];
}

export interface KcGroupSlice {
  name: string;   // имя группы из sa.product_groups; «Без группы» — product_group_id IS NULL; «Прочие (k)» — агрегат хвоста
  count: number;
}

export interface CalledToSaleCohortResult {
  points: CalledToSaleCohortPoint[];
  cohortTotal: number;   // = points[0].cohort — вся когорта, вошедшая в период
  soldTotal: number;     // Σ sold по всем точкам
  overallPct: number | null;
}

// Milestone-типы пятого графика v3 (три линии бронь/продажа/отгрузка) удалены
// в v4 (задача 2599, владелец 30.07: «переделай в 1 линию... аналогично этим
// двум графикам») — пятый график вернулся к общей форме CalledToSaleCohortResult
// (одна линия sold поверх когорты), см. workExclReservedCohort.ts.
