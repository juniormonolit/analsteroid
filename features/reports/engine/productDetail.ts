// ── «По товарам: детально» в дрилл-дауне (задача владельца 28.10.2026) ──────
//
// Альтернативный путь дрилл-дауна: те же сделки, что и в плоском списке
// («Группировка: Нет»), разложенные по уникальным ТОВАРАМ из их позиций
// (sa.deals.products). Сервер — /api/reports/deals?mode=products (тот же WHERE,
// те же фильтры и срез доступа, что у списка), клик по цифре — тот же роут со
// списком сделок, суженным productName + productStatus. Условия статусов ниже —
// ЕДИНСТВЕННЫЙ источник и для агрегата, и для списка по клику: иначе цифра и
// список разъедутся.
//
// Статус сделки — по ТЕКУЩЕЙ стадии (sa.stages.event_type), как цветной бейдж
// стадии в списке сделок (правило владельца «цвет ВСЕГДА следует текущей
// стадии», задачи #2367/#2532): проданную, а потом проигранную сделку
// продажей не считаем, возвращённую в работу — отказом тоже.
//
// Товар — название позиции (btrim(name)); пустое — «(без названия)». Одна
// сделка считается по товару один раз, даже если товар в ней несколькими
// строками; суммы — сумма строк этого товара (не сумма сделки целиком: сделка
// «плитка + бордюр + доставка» иначе дала бы плитке чужие деньги).

export type ProductStatus = 'sale' | 'shipment' | 'refusal' | 'no_stock' | 'expensive';

/** SQL-условие на строку sa.stages (префикс `p` — алиас с точкой или ''). */
export function productStatusStageWhere(status: ProductStatus, p: string): string {
  switch (status) {
    case 'sale':      return `${p}event_type IN ('sold', 'shipped')`;
    case 'shipment':  return `${p}event_type = 'shipped'`;
    case 'refusal':   return `${p}event_type = 'lost'`;
    // Отказные стадии Битрикса: «Нет в наличии» и семейство «Дорого…»
    // («Дорого, предложил другие материалы…» и т.п., см. DIAGNOSTICS_DECISIONS 12.5).
    case 'no_stock':  return `${p}event_type = 'lost' AND ${p}name ILIKE '%нет в наличии%'`;
    case 'expensive': return `${p}event_type = 'lost' AND ${p}name ILIKE 'дорого%'`;
  }
}

export const PRODUCT_STATUSES: ProductStatus[] = ['sale', 'shipment', 'refusal', 'no_stock', 'expensive'];

/** Позиции сделки `d` как массив (products бывает null/не-массивом). */
export const DEAL_PRODUCTS_ARR = `CASE WHEN jsonb_typeof(d.products) = 'array' THEN d.products ELSE '[]'::jsonb END`;

/** Ключ товара позиции `pl`. */
export function productKeySql(pl: string): string {
  return `COALESCE(NULLIF(btrim(${pl}->>'name'), ''), '(без названия)')`;
}

export interface ProductDetailRow {
  product: string;
  /** Группа товара позиции (head_group_name), самая частая у этого названия. */
  group: string | null;
  /** Сервисная позиция (перевозка, аренда техники…, см. serviceGroups.ts). */
  service: boolean;
  deals: number;
  sold: number;
  shipped: number;
  lost: number;
  noStock: number;
  expensive: number;
  amount: number;
  soldAmount: number;
  shippedAmount: number;
  lostAmount: number;
}

export interface ProductDetailResponse {
  rows: ProductDetailRow[];
  /** Все сделки выборки — знаменатель «Доли сделок с товаром». */
  totalDeals: number;
  /** Из них без единой позиции. */
  noProductDeals: number;
  noRule?: string;
}
