// Deal fields available as columns in the drilldown deal list (the "Сделки" config tab).
// `#` (deal_id) is always shown as the row id and is not toggleable.
export interface DealFieldDef {
  key: string;
  label: string;
  align?: 'left' | 'right';
  kind: 'text' | 'money' | 'date';
}

export const DEAL_FIELDS: DealFieldDef[] = [
  { key: 'deal_name',           label: 'Название',        kind: 'text' },
  { key: 'stage_name',          label: 'Стадия',          kind: 'text' },
  { key: 'funnel_name',         label: 'Воронка',         kind: 'text' },
  { key: 'manager_name',        label: 'Менеджер',        kind: 'text' },
  { key: 'product_group_name',  label: 'Группа (КЦ)',     kind: 'text' },
  { key: 'head_group_name',     label: 'Группа (наиб.)',  kind: 'text' },
  { key: 'source_name',         label: 'Источник',        kind: 'text' },
  { key: 'amount',              label: 'Сумма',           kind: 'money', align: 'right' },
  { key: 'created_at',          label: 'Создана',         kind: 'date',  align: 'right' },
  { key: 'reserved_at',         label: 'Бронь',           kind: 'date',  align: 'right' },
  { key: 'confirmed_at',        label: 'Подтв.',          kind: 'date',  align: 'right' },
  { key: 'sold_at',             label: 'Продажа',         kind: 'date',  align: 'right' },
  { key: 'delivered_at',        label: 'Отгрузка',        kind: 'date',  align: 'right' },
  { key: 'lost_at',             label: 'Проиграна',       kind: 'date',  align: 'right' },
  { key: 'expected_close_date', label: 'Ожид. закрытие',  kind: 'date',  align: 'right' },
];

// Дефолтный набор колонок — компактный (остальные добавляются в «Метрики → Сделки»)
export const DEFAULT_DEAL_FIELDS = [
  'deal_name', 'stage_name', 'funnel_name', 'amount',
  'created_at', 'reserved_at', 'confirmed_at', 'sold_at', 'delivered_at', 'lost_at',
];
