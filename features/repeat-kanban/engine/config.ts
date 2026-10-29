// Канбан повторных продаж (решения владельца 20.10.2026) — справочники колонок.
// Спецификация: ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md. Файл без импортов БД —
// его тянет и клиентский UI.
//
// Стадии повторных воронок сверены по crm.dealcategory.stage.list 20.10. Id обманчивы:
// C2:1 — отказ «Подвели клиента», а C3:1 — «Заказ в работе, счёт оплачен (продано)»;
// C3:EXECUTING — «Отправил счёт (бронь)». Сопоставлять только по этой таблице.

export const REPEAT_FUNNEL_IDS = [2, 3] as const;
/** Проект Битрикса «Повторные продажи» — сюда ставит задачи и старый канбан /crm/mltclients/. */
export const REPEAT_PROJECT_GROUP_ID = 118;
export const taskUrl = (id: number) => `https://td.monolit-crm.ru/workgroups/group/${REPEAT_PROJECT_GROUP_ID}/tasks/task/view/${id}/`;
/** Воронка для новой сделки: физлицо/контакт → 2 (B2C), компания → 3 (B2B). */
export const NEW_DEAL_STAGE: Record<2 | 3, string> = { 2: 'C2:NEW', 3: 'C3:NEW' };

/** Окно повторной продажи и правило трёх касаний (BACKLOG «3 звонка с интервалом 7 дней»). */
export const WINDOW_DAYS = 22;
export const WEEK_DAYS = 7;
export const TOUCHES = 3;
/** «Скрыть навсегда» (владелец 22.10): срок-заглушка вместо отдельной колонки в БД — все проверки
 *  «snooze_until >= сегодня» работают как есть; вернуть можно только кнопкой «Вернуть в пул». */
export const HIDE_FOREVER = '9999-12-31';
/** Срок скрытия для подписи: «навсегда» или дд.мм.гггг. */
export const fmtHideUntil = (until: string) => (until >= HIDE_FOREVER ? 'навсегда' : `до ${until.split('-').reverse().join('.')}`);

/** С этой даты отказы попадают на разбор РОПу. Старые отказы (до запуска раздела) на
 *  разбор не идут — иначе колонка с первого дня была бы на тысячи карточек. */
export const REVIEW_SINCE = '2026-10-21T00:00:00+03:00';

export type ColumnKey =
  | 'pool_hot' | 'pool_1' | 'pool_2_4' | 'pool_5'
  | 'touch_0' | 'touch_1' | 'touch_2' | 'touch_3'
  | 'st_called' | 'st_supply' | 'st_offer' | 'st_cheaper' | 'st_reserved' | 'st_sold'
  | 'review' | 'brak' | 'hidden';

export type ColumnGroup = 'pool' | 'touch' | 'stage' | 'review' | 'hidden';

export interface ColumnDef {
  key: ColumnKey;
  group: ColumnGroup;
  title: string;
  hint: string;
  /** Стадии Битрикса (только для group='stage'). */
  stages?: readonly string[];
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: 'pool_hot', group: 'pool', title: 'Срочно: окно открыто', hint: `Последняя отгрузка — не больше ${22} дней назад, повторной сделки нет: самое время брать в работу` },
  { key: 'pool_1', group: 'pool', title: '1 отгрузка', hint: 'Купил один раз, повторной сделки нет' },
  { key: 'pool_2_4', group: 'pool', title: '2–4 отгрузки', hint: 'Возвращался, повторной сделки сейчас нет' },
  { key: 'pool_5', group: 'pool', title: 'Золотые рыбки', hint: '5 и более отгрузок, повторной сделки сейчас нет' },
  { key: 'touch_0', group: 'touch', title: 'Взят в работу', hint: 'Достали из пула: сделка создана или возвращена, задача поставлена, попыток связаться ещё не было' },
  { key: 'touch_1', group: 'touch', title: '1-я попытка', hint: 'Был один день с попыткой связаться (звонок, в т.ч. недозвон, или контакт)' },
  { key: 'touch_2', group: 'touch', title: '2-я попытка', hint: 'Два разных дня с попыткой связаться' },
  { key: 'touch_3', group: 'touch', title: '3-я попытка', hint: 'Последняя: дозвон — в стадию воронки, нет — в отказ' },
  { key: 'st_called', group: 'stage', title: 'Созвонился, уточнил материалы', hint: 'Стадия повторной воронки', stages: ['C2:3', 'C3:3'] },
  { key: 'st_supply', group: 'stage', title: 'Запрос снабженцу', hint: 'Стадия повторной воронки', stages: ['C2:PREPARATION', 'C3:PREPARATION'] },
  { key: 'st_offer', group: 'stage', title: 'Материалы / КП', hint: 'B2C: заполнил материалы и запланировал звонок · B2B: отправил КП', stages: ['C2:PREPAYMENT_INVOICE', 'C3:PREPAYMENT_INVOICE'] },
  { key: 'st_cheaper', group: 'stage', title: 'Цена дешевле', hint: 'Есть цена дешевле, запросил предложение лучше', stages: ['C2:4', 'C3:4'] },
  { key: 'st_reserved', group: 'stage', title: 'Бронь', hint: 'Забронировано / подтверждённая бронь / счёт', stages: ['C2:EXECUTING', 'C2:5', 'C3:EXECUTING', 'C3:FINAL_INVOICE'] },
  { key: 'st_sold', group: 'stage', title: 'Продано', hint: 'Продано, ждёт отгрузки', stages: ['C2:FINAL_INVOICE', 'C3:1'] },
  { key: 'review', group: 'review', title: 'Отказ на проверке', hint: 'Сделку закрыли в отказ — РОП подтверждает брак или возвращает' },
  { key: 'brak', group: 'review', title: 'Брак', hint: 'Отказ подтверждён РОПом или «сразу в брак»' },
  { key: 'hidden', group: 'hidden', title: 'Скрытые', hint: 'Скрыты из пула до даты с комментарием; после даты — сами вернутся в пул' },
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
/** «Количество отгрузок» (владелец 29.10): корзины фильтра доски. */
export const SHIP_BUCKETS = [
  { value: '0', label: 'Отгрузок не было' }, { value: '1', label: '1 отгрузка' }, { value: '2', label: '2 отгрузки' }, { value: '3', label: '3 отгрузки' },
  { value: '4-5', label: '4–5 отгрузок' }, { value: '6-9', label: '6–9 отгрузок' }, { value: '10+', label: '10 и больше' },
] as const;
export const shipBucket = (n: number): string => (n <= 0 ? '0' : n <= 3 ? String(n) : n <= 5 ? '4-5' : n <= 9 ? '6-9' : '10+');

export type ReviewDecision = 'brak' | 'no_answer' | 'return' | 'postpone';

/** «Отложить до…» (владелец 26.10: «буду строиться весной» — не брак, а скрыть до даты). Пресеты дат. */
export function postponePresets(now = new Date()): { value: string; label: string }[] {
  const msk = new Date(now.getTime() + 3 * 3600_000);
  const y = msk.getUTCFullYear(), today = msk.toISOString().slice(0, 10);
  const next = (m: number, d = 1) => { const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return s > today ? s : `${y + 1}${s.slice(4)}`; };
  const plus3 = new Date(Date.UTC(y, msk.getUTCMonth() + 3, msk.getUTCDate())).toISOString().slice(0, 10);
  return [{ value: next(3), label: '1 марта' }, { value: next(4), label: '1 апреля' }, { value: plus3, label: '+3 месяца' }];
}

/** Похоже, что менеджер принёс «позже» (весной, осенью, после НГ, через N месяцев) — дата по смыслу или null. */
export function guessPostpone(text: string | null | undefined, now = new Date()): string | null {
  const t = (text ?? '').toLowerCase();
  if (!t) return null;
  const p = postponePresets(now);
  if (/весн|в марте|к марту/.test(t)) return p[0].value;
  if (/в апреле|к апрелю/.test(t)) return p[1].value;
  const msk = new Date(now.getTime() + 3 * 3600_000), y = msk.getUTCFullYear();
  const fut = (m: number) => { const s = `${y}-${String(m).padStart(2, '0')}-01`; return s > msk.toISOString().slice(0, 10) ? s : `${y + 1}-${String(m).padStart(2, '0')}-01`; };
  if (/лет[оа]м|к лету|в мае/.test(t)) return fut(5);
  if (/осен/.test(t)) return fut(9);
  if (/после нов\w* год|в январе|в следующем году|в новом году/.test(t)) return `${fut(1).slice(0, 8)}15`;
  const m = t.match(/через\s+(\d+|пару|два|три|полгода)\s*(мес|месяц)?/);
  if (m) {
    const n = m[1] === 'пару' || m[1] === 'два' ? 2 : m[1] === 'три' ? 3 : m[1] === 'полгода' ? 6 : Number(m[1]);
    if (m[1] === 'полгода' || m[2]) return new Date(Date.UTC(y, msk.getUTCMonth() + Math.min(n, 12), msk.getUTCDate())).toISOString().slice(0, 10);
  }
  return null;
}
/** Причины брака — как отказные стадии повторных воронок Битрикса (владелец 21.10: «такие же, как в
 *  Битриксе»). C3:2 «Объектов больше нет», C2:APOLOGY «Больше ничего не нужно», C2/C3:LOSE «Дорого…»,
 *  C2:1/C3:APOLOGY «Подвели клиента…». Старые значения (competitor/negative/other) — только для истории
 *  (LEGACY_BRAK_LABELS), выбрать их больше нельзя. Миграция 236 расширила CHECK в customer_marks. */
export const BRAK_REASONS = [
  { value: 'no_objects', label: 'Объектов больше нет' },
  { value: 'nothing_needed', label: 'Больше ничего не нужно' },
  { value: 'expensive', label: 'Дорого, предложил другие материалы, больше ничего не нужно' },
  { value: 'failed_client', label: 'Подвели клиента — не хочет с нами работать' },
] as const;
export type BrakReason = (typeof BRAK_REASONS)[number]['value'];
export const LEGACY_BRAK_LABELS: Record<string, string> = { competitor: 'Ушёл к конкуренту', negative: 'Негатив', other: 'Прочее' };

/** Цвет чипа типа клиента (владелец 20.10: «стройорганизация должна привлекать внимание»,
 *  аудит Fable): ценные — заливкой, остальные — контуром, «не указан» — серый пунктир.
 *  Цвета — «Основная палитра» проекта (Google Sheets 10×8). */
export const CLIENT_TYPE_STYLE: Record<string, { bg: string; fg: string; border: string; dashed?: boolean }> = {
  construction_org: { bg: '#351c75', fg: '#ffffff', border: '#351c75' },
  foreman: { bg: '#f6b26b', fg: '#783f04', border: '#e69138' },
  self_builder: { bg: 'transparent', fg: '#38761d', border: '#6aa84f' },
  self_builder_late: { bg: 'transparent', fg: '#134f5c', border: '#45818e' },
  own_needs_org: { bg: 'transparent', fg: '#741b47', border: '#a64d79' },
  none: { bg: 'transparent', fg: '#999999', border: '#b7b7b7', dashed: true },
};

/** Фильтр товарной группы (владелец 22.10): last — группа ПОСЛЕДНЕЙ отгрузки (только пул), ever —
 *  отгружали когда-либо за период (вся доска, engine/shippedGroups.ts). */
export type GroupMode = 'last' | 'ever';
export const GROUP_PERIODS = [
  { value: '3m', label: '3 месяца', months: 3 },
  { value: '6m', label: 'Полгода', months: 6 },
  { value: '1y', label: 'Год', months: 12 },
  { value: '2y', label: '2 года', months: 24 },
  { value: 'all', label: 'Всё время', months: null },
  { value: 'custom', label: 'Свои даты', months: null },
] as const;
export type GroupPeriod = (typeof GROUP_PERIODS)[number]['value'];

/** «Кандидат на ИИ-разбор» (владелец 23.10): разбора нет, а звонков с расшифровкой не меньше стольких. */
export const AI_CANDIDATE_MIN = 5;
