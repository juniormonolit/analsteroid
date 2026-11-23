// «Карта показателей» (задача владельца 23.11) — ОБЩИЙ КОНТРАКТ движка и интерфейса.
// Движок (features/metric-map/engine/*, app/api/metric-map/*) отдаёт MetricMapResponse,
// интерфейс (features/metric-map/ui/*) только рисует его и считает «что если» на клиенте.
// Менять контракт — синхронно в обеих частях.
//
// Модель (согласовано с владельцем 23.11, консультация Fable):
// - дерево из узлов-сумм ('sum': родитель = Σ детей) и узлов-произведений
//   ('product': родитель = Π детей). Множители определены ТЕЛЕСКОПИЧЕСКИ
//   (продажи/сделки × сумма/продажи × отгрузки/сумма продаж …), поэтому произведение
//   тождественно равно факту родителя в КАЛЕНДАРНОМ режиме; невязка (residual) — только
//   от округлений/данных и показывается явно;
// - первичка/повторка — ПО ВОРОНКЕ (funnels.is_repeat);
// - эталон сравнения — МЕДИАНА КОМАНДЫ по менеджерам (не усечённое среднее);
//   сами узлы — всегда отношения сумм, не среднее средних;
// - вес узла-слагаемого = доля в родителе; вес множителя = вклад в рублях в отклонение
//   от периода сравнения (LMDI) и потенциал «подтянуть до медианы команды».

export type MapNodeKind = 'sum' | 'product' | 'leaf';
export type MapUnit = 'rub' | 'count' | 'pct' | 'ratio';

export interface MapNodeDef {
  id: string;
  label: string;              // «CR Сделка → Продажа (перв.)» — по правилам каталога метрик
  kind: MapNodeKind;
  unit: MapUnit;              // pct хранится долей 0..1, рисуется в %
  children?: string[];        // для sum/product — id детей в порядке показа
  formula: string;            // человекочитаемо: «Сумма продаж (перв.) / Кол-во продаж (перв.)»
  description?: string;       // что значит и как считается — для подсказки
  /** Минимальный знаменатель, ниже которого значение помечается lowSample. */
  minSample?: number;
}

export interface MapNodeValue {
  value: number | null;
  /** Значение в периоде сравнения (по умолчанию — предыдущий такой же период). */
  prev: number | null;
  /** Медиана по менеджерам команды (только менеджеры с достаточной выборкой). */
  teamMedian: number | null;
  /** Знаменатель отношения (для leaf/sum — само количество), для порога выборки. */
  sampleSize: number | null;
  lowSample: boolean;
  /** Для детей sum-узла: доля в родителе (0..1). */
  share?: number | null;
  /** Вклад узла в изменение КОРНЯ дерева к периоду сравнения, ₽ (LMDI, сходится без остатка). */
  contribution?: number | null;
  /** На сколько ₽ вырос бы корень, если поднять узел до медианы команды (только если ниже). */
  potential?: number | null;
}

export type MapScopeType = 'company' | 'department' | 'manager' | 'product_group';

export interface MapScope {
  type: MapScopeType;
  id: string | null;          // null для company
  label: string;
}

export interface MapPeriod {
  from: string;               // YYYY-MM-DD включительно
  to: string;                 // YYYY-MM-DD включительно
  label: string;              // «Октябрь 2026»
}

export interface MetricMapResponse {
  rootId: string;
  nodes: MapNodeDef[];
  values: Record<string, MapNodeValue>;
  scope: MapScope;
  period: MapPeriod;
  comparePeriod: MapPeriod;
  /** Факт корня минус значение, собранное по дереву (₽); null — если не посчитать. */
  residual: number | null;
  computedAt: string;         // ISO; время пересчёта снимка
  /** Окно (мес.) для медиан команды и «справочных» весов. */
  windowMonths: number;
}

// API (реализует движок):
//   GET  /api/metric-map?scope=company|department:<id>|manager:<id>|product_group:<id>
//                       &from=YYYY-MM-DD&to=YYYY-MM-DD[&compareFrom=..&compareTo=..]
//        → MetricMapResponse
//   POST /api/metric-map/recompute   (кнопка «Пересчитать»; ночью — фоновая задача)
//        → { ok: true, computedAt: string }
