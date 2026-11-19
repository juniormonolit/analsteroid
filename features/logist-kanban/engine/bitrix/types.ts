// S4 — типы записи в Битрикс (клиентобезопасно, без рантайм-импортов): предпросмотр «было/станет»
// товаров сделки для «Принять вариант» и подтверждение записи.

/** Строка товаров сделки в предпросмотре. */
export interface DealRowView {
  /** ID строки crm.deal.productrows (у новой — null) */
  rowId: number | null;
  /** товар каталога; null — свободная строка (PRODUCT_NAME без PRODUCT_ID) */
  productId: number | null;
  name: string;
  quantity: number;
  measure: string | null;
  price: number;
  sum: number;
}

export type DealRowChangeKind = 'keep' | 'replace' | 'add';
export interface DealRowChange {
  kind: DealRowChangeKind;
  /** было (у add — null) */
  before: DealRowView | null;
  /** станет (у replace — первая из строк варианта, остальные — отдельными add) */
  after: DealRowView | null;
  note: string | null;
}

/** GET /api/logist-kanban/request/:id/deal-rows?offerId= — что станет с товарами сделки, если принять вариант.
 *  Ничего не пишет. Кнопку «Принять» рисовать с подтверждением по этому ответу и передать hash обратно. */
export interface DealRowsPreview {
  dealId: number;
  offerId: number; offerN: number;
  before: DealRowView[];
  after: DealRowView[];
  changes: DealRowChange[];
  beforeTotal: number; afterTotal: number;
  /** что стоит прочитать перед подтверждением (нет в наличии, нет цены и т.п.) */
  warnings: string[];
  /** отпечаток текущих строк сделки: при записи сверяется — сделку успели поменять → 409, нужен новый предпросмотр */
  hash: string;
  /** false — запись товаров выключена (флаг LOGIST_BX_DEAL_ROWS / тестовые списки): принять можно, строки не изменятся */
  writeEnabled: boolean;
  blockedReason: string | null;
}

/** Поле `dealRows` в теле action `accept` и тело POST /request/:id/deal-rows.
 *  Без него (или confirm≠true) «Принять» сделки не трогает: deal_rows_status='skipped'. */
export interface DealRowsConfirm { confirm: true; hash: string }

/** POST /api/logist-kanban/request/:id/deal-rows — записать товары принятого варианта (повтор после ошибки,
 *  или если при «Принять» не подтверждали). Тело: DealRowsConfirm. */
export interface DealRowsWriteResponse { status: 'ok' | 'error' | 'skipped'; error: string | null; preview: DealRowsPreview }
