// Канбан больших чеков (BIG_DEALS_KANBAN_SPEC.md, решения владельца 18.11).
// Карточка = задача Битрикса из проектов больших сделок. Колонки — ОБЩАЯ сетка для всех
// проектов: у каждого проекта свои стадии (task.stages.get, id разные), сводим по названию.
// Стадии сверены с порталом 18.11.

export const BIG_DEALS_GROUPS = [
  { id: 72, name: 'Большие сделки НЦ', short: 'НЦ' },
  { id: 74, name: 'Большие сделки ОС', short: 'ОС' },
  { id: 79, name: 'КРД Большие сделки', short: 'КРД' },
  { id: 80, name: 'МСК Большие сделки НЦ', short: 'МСК НЦ' },
  { id: 81, name: 'МСК Большие сделки ОС', short: 'МСК ОС' },
  { id: 108, name: 'МСК Большие сделки НЦ ЖБИ', short: 'МСК ЖБИ' },
] as const;
export const BIG_DEALS_GROUP_IDS: readonly number[] = BIG_DEALS_GROUPS.map(g => g.id);

export type BigColumnKey =
  | 'new' | 'logist' | 'assigned' | 'check' | 'check_important' | 'hold'
  | 'reserve' | 'invoice' | 'reserve_confirmed' | 'close_or_lose'
  | 'sold' | 'lost_check' | 'lost_done';

export interface BigColumnDef {
  key: BigColumnKey;
  title: string;
  /** Подсказка под заголовком колонки. */
  hint?: string;
  /** hex без # — цвет шапки (как в Битриксе). */
  color: string;
  /** Финальная колонка: задача здесь живёт закрытой, «застрявшей» не считается. */
  final?: boolean;
}

/** Порядок колонок общей сетки. */
export const BIG_COLUMNS: readonly BigColumnDef[] = [
  { key: 'new', title: 'Новые', hint: 'на РОПе, не разобраны', color: '00c4fb' },
  { key: 'logist', title: 'Нет ответа от логиста', color: 'ff5752' },
  { key: 'assigned', title: 'Назначил менеджера, дал ТЗ', color: 'eec200' },
  { key: 'hold', title: 'Пока не трогать', color: '6b7280' },
  { key: 'check', title: 'Проверить', color: '2f6bff' },
  { key: 'check_important', title: 'Проверить важное', color: '1d4ed8' },
  { key: 'reserve', title: 'Бронь', hint: 'физлица', color: '2eceff' },
  { key: 'invoice', title: 'Отправил счёт', hint: 'бронь юрлиц', color: '47d1e2' },
  { key: 'reserve_confirmed', title: 'Подтверждённая бронь', color: '0070bf' },
  { key: 'close_or_lose', title: 'Закрыть, если не купят', color: 'f26b47' },
  { key: 'sold', title: 'Продано', color: '75d900', final: true },
  { key: 'lost_check', title: 'Не продано (проверка)', hint: 'РОП проверяет работу менеджера', color: 'ff5752' },
  { key: 'lost_done', title: 'Не продано (проверено)', color: 'ffab00', final: true },
];

/** Название стадии проекта (нижний регистр, ё→е, без лишних пробелов) → колонка общей сетки.
 *  null — стадия не показывается (мусорная «Название» у 72). Неизвестное название → 'check'
 *  и предупреждение в лог (новую стадию завели в Битриксе — добавить сюда). */
export const STAGE_TITLE_TO_COLUMN: Record<string, BigColumnKey | null> = {
  'новые': 'new',
  'нет ответа от логиста': 'logist',
  'назначил менеджера дал тз': 'assigned',
  'поставлена задача моп': 'assigned',
  'пока не трогать': 'hold',
  'проверить': 'check',
  'газобетон': 'check', // товарная стадия Осипова (74) — по смыслу «проверить»
  'проверить важное': 'check_important',
  'бронь': 'reserve',
  'отправил счет': 'invoice',
  'подтвержденная бронь': 'reserve_confirmed',
  'закрыть к хуям, если не купят': 'close_or_lose',
  'продано': 'sold',
  'не продано (проверка)': 'lost_check',
  'не продано': 'lost_check', // у 72 одна колонка отказа
  'разобрать повторно': 'lost_check',
  'не продано (проверено)': 'lost_done',
  'не продано (подтверждено)': 'lost_done',
  'название': null,
};

export const normStageTitle = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Колонки, попав в которые задача закрывается (решение владельца 18.11: «при не продано можно смело
 *  завершать задачу» — чтобы не висела на менеджере «ждёт контроля»). */
export const AUTO_COMPLETE_COLUMNS: ReadonlySet<BigColumnKey> = new Set(['lost_check', 'lost_done']);

/** Застряла: дней в колонке больше порога (встреча 11.11: «жизнь сделки — неделя», бронь 2 недели — ненормально). */
export const STUCK_DAYS: Partial<Record<BigColumnKey, number>> = {
  new: 1, logist: 3, assigned: 2, check: 2, check_important: 2, reserve: 5, invoice: 5,
  reserve_confirmed: 5, close_or_lose: 3, lost_check: 2,
};

/** Приоритет колонок в «Сегодня» (Осипов: ждёт контроля → подтверждённая бронь → бронь → товарная группа). */
export const COLUMN_PRIORITY: readonly BigColumnKey[] = [
  'reserve_confirmed', 'reserve', 'invoice', 'check_important', 'check', 'close_or_lose', 'assigned', 'logist', 'new', 'lost_check', 'hold',
];

export const taskUrl = (id: number) => `https://td.monolit-crm.ru/company/personal/user/0/tasks/task/view/${id}/`;
export const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;
