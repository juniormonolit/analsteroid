// Канбан повторных продаж (решения владельца 20.10.2026) — справочники колонок.
// Спецификация: ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md. Файл без импортов БД —
// его тянет и клиентский UI.
//
// Стадии повторных воронок сверены по crm.dealcategory.stage.list 20.10. Id обманчивы:
// C2:1 — отказ «Подвели клиента», а C3:1 — «Заказ в работе, счёт оплачен (продано)»;
// C3:EXECUTING — «Отправил счёт (бронь)». Сопоставлять только по этой таблице.

export const REPEAT_FUNNEL_IDS = [2, 3] as const;
/** Воронка для новой сделки: физлицо/контакт → 2 (B2C), компания → 3 (B2B). */
export const NEW_DEAL_STAGE: Record<2 | 3, string> = { 2: 'C2:NEW', 3: 'C3:NEW' };

/** Окно повторной продажи и правило трёх касаний (BACKLOG «3 звонка с интервалом 7 дней»). */
export const WINDOW_DAYS = 22;
export const WEEK_DAYS = 7;
export const TOUCHES = 3;

/** С этой даты отказы попадают на разбор РОПу. Старые отказы (до запуска раздела) на
 *  разбор не идут — иначе колонка с первого дня была бы на тысячи карточек. */
export const REVIEW_SINCE = '2026-10-21T00:00:00+03:00';

export type ColumnKey =
  | 'pool_1' | 'pool_2_4' | 'pool_5'
  | 'touch_0' | 'touch_1' | 'touch_2' | 'touch_3'
  | 'st_called' | 'st_supply' | 'st_offer' | 'st_cheaper' | 'st_reserved' | 'st_sold'
  | 'review' | 'brak';

export type ColumnGroup = 'pool' | 'touch' | 'stage' | 'review';

export interface ColumnDef {
  key: ColumnKey;
  group: ColumnGroup;
  title: string;
  hint: string;
  /** Стадии Битрикса (только для group='stage'). */
  stages?: readonly string[];
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: 'pool_1', group: 'pool', title: '1 отгрузка', hint: 'Купил один раз, повторной сделки нет' },
  { key: 'pool_2_4', group: 'pool', title: '2–4 отгрузки', hint: 'Возвращался, повторной сделки сейчас нет' },
  { key: 'pool_5', group: 'pool', title: 'Золотые рыбки', hint: '5 и более отгрузок, повторной сделки сейчас нет' },
  { key: 'touch_0', group: 'touch', title: 'Контакт 0/3', hint: 'Окно 22 дня: ни одной недели с контактом' },
  { key: 'touch_1', group: 'touch', title: 'Контакт 1/3', hint: 'Окно 22 дня: контакт на одной неделе из трёх' },
  { key: 'touch_2', group: 'touch', title: 'Контакт 2/3', hint: 'Окно 22 дня: контакт на двух неделях из трёх' },
  { key: 'touch_3', group: 'touch', title: 'Контакт 3/3', hint: 'Три недели с контактом — сделку можно закрывать' },
  { key: 'st_called', group: 'stage', title: 'Созвонился, уточнил материалы', hint: 'Стадия повторной воронки', stages: ['C2:3', 'C3:3'] },
  { key: 'st_supply', group: 'stage', title: 'Запрос снабженцу', hint: 'Стадия повторной воронки', stages: ['C2:PREPARATION', 'C3:PREPARATION'] },
  { key: 'st_offer', group: 'stage', title: 'Материалы / КП', hint: 'B2C: заполнил материалы и запланировал звонок · B2B: отправил КП', stages: ['C2:PREPAYMENT_INVOICE', 'C3:PREPAYMENT_INVOICE'] },
  { key: 'st_cheaper', group: 'stage', title: 'Цена дешевле', hint: 'Есть цена дешевле, запросил предложение лучше', stages: ['C2:4', 'C3:4'] },
  { key: 'st_reserved', group: 'stage', title: 'Бронь', hint: 'Забронировано / подтверждённая бронь / счёт', stages: ['C2:EXECUTING', 'C2:5', 'C3:EXECUTING', 'C3:FINAL_INVOICE'] },
  { key: 'st_sold', group: 'stage', title: 'Продано', hint: 'Продано, ждёт отгрузки', stages: ['C2:FINAL_INVOICE', 'C3:1'] },
  { key: 'review', group: 'review', title: 'Отказ на проверке', hint: 'Сделку закрыли в отказ — РОП подтверждает брак или возвращает' },
  { key: 'brak', group: 'review', title: 'Брак', hint: 'Отказ подтверждён РОПом' },
];

export const NEW_STAGES: ReadonlySet<string> = new Set(['C2:NEW', 'C3:NEW']);
export const WON_STAGES: ReadonlySet<string> = new Set(['C2:WON', 'C3:WON']);
export const LOST_STAGES: ReadonlySet<string> = new Set([
  'C2:LOSE', 'C2:APOLOGY', 'C2:1', 'C2:2', 'C3:LOSE', 'C3:APOLOGY', 'C3:2',
]);
export const STAGE_TO_COLUMN: ReadonlyMap<string, ColumnKey> = new Map(
  COLUMNS.flatMap(c => (c.stages ?? []).map(s => [s, c.key] as const)),
);

/** Порядок типов клиента (карточка клиента, sa.client_module_profiles): прорабы —
 *  «самые сладкие пирожочки» (владелец 20.10). Меньше — выше. */
export const CLIENT_TYPE_ORDER: Record<string, number> = {
  foreman: 0,
  construction_org: 1,
  self_builder: 2,
  self_builder_late: 3,
  own_needs_org: 4,
};
export const CLIENT_TYPE_NONE_RANK = 9;
export const CLIENT_TYPE_SHORT: Record<string, string> = {
  foreman: 'Прораб',
  construction_org: 'Стройорганизация',
  self_builder: 'Строит себе · начало',
  self_builder_late: 'Строит себе · финал',
  own_needs_org: 'Орг. под свои нужды',
};

/** Решения РОПа по отказу. */
export type ReviewDecision = 'brak' | 'no_answer' | 'return';
export const BRAK_REASONS = [
  { value: 'nothing_needed', label: 'Ничего не нужно' },
  { value: 'competitor', label: 'Ушёл к конкуренту' },
  { value: 'negative', label: 'Послал / негатив' },
  { value: 'other', label: 'Прочее' },
] as const;
export type BrakReason = (typeof BRAK_REASONS)[number]['value'];
