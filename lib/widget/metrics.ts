// Отображаемые метрики конструктора виджетов — единый источник для среза, валидации и UI.
// Данные в Redis (lib/jobs/widgetMetrics.ts) остаются сырыми (план/факт/счётчики) — здесь
// ТОЛЬКО слой отображения. Переработка 17.07 по фидбеку владельца:
//  - план/факт НЕ двумя кольцами, а ОДНИМ «Выполнение плана, %» (заполнение дуги = %);
//  - абсолютные суммы (₽) — отдельные метрики и ТОЛЬКО для периода «Этот год»
//    («план/факт на текущий день — в разрезе месяца, в абсолюте — только год»).

export type WidgetMetricId =
  | 'sales_completion' | 'shipments_completion'   // % выполнения плана (факт/план к тек. дню)
  | 'fact_sales' | 'fact_shipments'               // абсолют (₽), только this_year
  | 'cr_sale' | 'cr_shipment';                    // конверсии (перв.), %

export interface WidgetMetricDef {
  id: WidgetMetricId;
  label: string;       // подпись под кольцом
  shortLabel: string;  // для узких мест
  kind: 'completion' | 'money' | 'percent';
  /** Абсолютные суммы показываем только в годовом разрезе. */
  yearOnly: boolean;
}

export const WIDGET_METRICS: WidgetMetricDef[] = [
  { id: 'sales_completion',     label: 'Вып. плана продаж',   shortLabel: 'план продаж',  kind: 'completion', yearOnly: false },
  { id: 'shipments_completion', label: 'Вып. плана отгрузок', shortLabel: 'план отгр.',   kind: 'completion', yearOnly: false },
  { id: 'fact_sales',           label: 'Продажи, ₽',          shortLabel: 'продажи',      kind: 'money',      yearOnly: true },
  { id: 'fact_shipments',       label: 'Отгрузки, ₽',         shortLabel: 'отгрузки',     kind: 'money',      yearOnly: true },
  { id: 'cr_sale',              label: 'CR в продажу',        shortLabel: 'CR продажа',   kind: 'percent',    yearOnly: false },
  { id: 'cr_shipment',          label: 'CR в отгрузку',       shortLabel: 'CR отгрузка',  kind: 'percent',    yearOnly: false },
];

export const WIDGET_METRIC_IDS = WIDGET_METRICS.map(m => m.id);

// Конфиги, сохранённые до переработки 17.07, хранят старые id — маппим на новые
// (plan_* слились с fact_* в completion-метрики).
export const LEGACY_METRIC_MAP: Record<string, WidgetMetricId> = {
  plan_sales: 'sales_completion',
  plan_shipments: 'shipments_completion',
};

/** Сырые значения одной ячейки матрицы предрасчёта (как их пишет джоба). */
export interface WidgetMetricValues {
  plan_sales: number | null;
  fact_sales: number;
  plan_shipments: number | null;
  fact_shipments: number;
  cr_sale: number | null;
  cr_shipment: number | null;
}
