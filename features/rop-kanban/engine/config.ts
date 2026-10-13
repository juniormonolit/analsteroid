// Канбан РОПа (пилот, задача #9625) — конфигурация колонок, перенесённая из Битрикса.
//
// Источник логики: MLT-IT/crm (master, 13.10.2026), local/php_interface/lib/Modules/
// MltKanban/Sales/MltSalesKanbanService.php + Config/SalesKanbanConfig.php. Здесь только
// СПРАВОЧНИКИ (какие стадии/группы задач входят в колонку) и описание колонок; сами
// запросы — engine/kanban.ts (только SELECT, схема sa).
//
// Enum'ы DealStageIds/SonetGroupIds в скачанной копии кода отсутствуют, поэтому id стадий
// сопоставлены по ЖИВОМУ sa.stages (13.10): имя стадии + воронка 0/1/2/3 = Primary B2C /
// Primary B2B / Secondary B2C / Secondary B2B. Сомнительное сопоставление — «Запрос
// логисту» (см. LOGIST_REQUEST_STAGES) — помечено ниже и вынесено в отчёт задачи.

/** Воронки: 0 — первичные ЧЛ (B2C), 1 — первичные ЮЛ (B2B), 2 — повторные B2C, 3 — повторные B2B. */
export const PRIMARY_FUNNEL_IDS = [0, 1] as const;

/** DealStageIds::Primary{B2C,B2B}_Unprocessed — только первичные воронки. */
export const UNPROCESSED_STAGES = ['NEW', 'C1:NEW'] as const;

/** DealStageIds::*_Sale — «Продано» (не «Отгружено»). */
export const SALE_STAGES = ['2', 'C1:3', 'C2:FINAL_INVOICE', 'C3:1'] as const;

/** DealStageIds::PrimaryB2C_Reserved, PrimaryB2B_SentReserveInvoice, SecondaryB2C/B2B_Reserved. */
export const RESERVED_STAGES = ['UC_SQEHTU', 'C1:1', 'C2:EXECUTING', 'C3:EXECUTING'] as const;

/** DealStageIds::*_HasBetterPrice — «Есть цена дешевле, запросил предложение лучше». */
export const BETTER_PRICE_STAGES = ['UC_PU4HM2', 'C1:11', 'C2:4', 'C3:4'] as const;

/**
 * DealStageIds::*_LogistRequest. ДОПУЩЕНИЕ: «Сделал запрос снабженцу, созвонился с
 * заказчиком» (в повторных воронках id обманчив — C2:PREPARATION / C3:PREPARATION; тот же
 * набор уже используется в features/reports/engine/stageSnapshot.ts как «contacted»).
 * Enum Битрикса не проверен — сверка с Битрикс-канбаном (шаг 3 плана) подтвердит.
 */
export const LOGIST_REQUEST_STAGES = ['EXECUTING', 'C1:EXECUTING', 'C2:PREPARATION', 'C3:PREPARATION'] as const;

/**
 * Статусы задач Битрикса (Bitrix\Tasks\Internals\Task\Status): 1 новая, 2 ждёт выполнения,
 * 3 выполняется, 4 ждёт контроля («предположительно завершена»), 5 завершена.
 */
export const TASK_STATUS = {
  NEW: 1, PENDING: 2, IN_PROGRESS: 3, SUPPOSEDLY_COMPLETED: 4, COMPLETED: 5,
} as const;
export const TASKS_OPEN = [1, 2, 3] as const;
export const TASKS_OPEN_OR_CONTROL = [1, 2, 3, 4] as const;
export const TASKS_ANSWERED = [4, 5] as const;

/**
 * Группы задач (b_sonet_group). В Битриксе ищутся по KEYWORDS LIKE '%логистика%' /
 * '%большие-сделки%' / '%повторные-сделки%'. Роль приложения (junior_user) не имеет
 * SELECT на sa.bitrix_groups / sa.bitrix_logist_groups, поэтому id зафиксированы по
 * состоянию на 13.10.2026 (читалось владельцем БД, read-only). Новая группа в Битриксе
 * сюда сама не попадёт — см. отчёт: нужен GRANT SELECT на эти две таблицы.
 */
export const LOGIST_GROUP_IDS = [
  5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24, 61, 70, 71, 97, 102,
] as const;
export const BIG_DEALS_GROUP_IDS = [72, 74, 79, 80, 81, 108] as const;
export const REPEATING_DEALS_GROUP_IDS = [73, 82, 106] as const;
/** SonetGroupIds::DebtClients / UpdClients / CallerIssues. */
export const DEBT_GROUP_ID = 40;
export const UPD_GROUP_ID = 63;
export const CALLER_ISSUES_GROUP_ID = 64;

/** Окно «логистических» задач для колонок цены/запроса/неотвеченных: ACTIVITY_DATE за 14 дней. */
export const LOGIST_TASK_WINDOW_DAYS = 14;

/** Потолок строк одной колонки из БД (страховка; реальные колонки — до ~1000). */
export const COLUMN_ROW_LIMIT = 3000;
/** Сколько карточек одного менеджера в полосе показываем; остальное — «ещё N». */
export const CARDS_PER_MANAGER = 50;

// ── Циклы дня (SalesKanbanConfig::getCycles) ────────────────────────────────────────────────
export type CycleKey = 'ONE' | 'TWO' | 'THREE' | 'END' | 'OTHER';
export interface CycleDef { key: CycleKey; title: string; short: string }
export const CYCLES: readonly CycleDef[] = [
  { key: 'ONE', title: '1 цикл (до 12:00)', short: '1 цикл' },
  { key: 'TWO', title: '2 цикл (до 16:00)', short: '2 цикл' },
  { key: 'THREE', title: '3 цикл (до 17:30)', short: '3 цикл' },
  { key: 'END', title: '4 цикл (с 17:30) - Приятное завершение дня', short: '4 цикл' },
  { key: 'OTHER', title: 'Другое', short: 'Другое' },
];
export const CYCLE_KEYS = CYCLES.map(c => c.key) as CycleKey[];
/** Режим «все колонки» (CYCLE_ALL в MltSalesKanbanService; в Битриксе — снимок для отчёта). */
export const CYCLE_ALL = 'ALL';
export type CycleParam = CycleKey | typeof CYCLE_ALL;
export const CYCLE_PARAMS: readonly CycleParam[] = [...CYCLE_KEYS, CYCLE_ALL];

export function parseCycleParam(raw: string | null | undefined): CycleParam | null {
  return raw && (CYCLE_PARAMS as readonly string[]).includes(raw) ? (raw as CycleParam) : null;
}

/** Текущий цикл по времени МСК: до 12:00 — 1-й, до 16:00 — 2-й, до 17:30 — 3-й, дальше — 4-й. */
export function currentCycleByTime(now: Date = new Date()): CycleKey {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  const minutes = h * 60 + m;
  if (minutes < 12 * 60) return 'ONE';
  if (minutes < 16 * 60) return 'TWO';
  if (minutes < 17 * 60 + 30) return 'THREE';
  return 'END';
}

// ── Колонки (SalesKanbanConfig::getColumns('default'), порядок и названия — как в Битриксе) ─
export type ColumnKey =
  | 'unprocessedDeals' | 'noActivities' | 'reservedWithActivitiesForToday' | 'confirmedReservedWithActivitiesForToday'
  | 'betterPrice' | 'logistRequest' | 'shipmentToday' | 'logistNotAnswered' | 'withBigDealsTasks' | 'stageCalled'
  | 'repeatedSaleImportant' | 'unprocessedSecondary' | 'regularClients' | 'stageCalledLowPriority' | 'secondaryToday'
  | 'shipmentTomorrow' | 'withRepeatingDealsTasks' | 'debtTasks' | 'callerIssuesTasks' | 'newDeals' | 'noProducts'
  | 'withExpiredActivities' | 'withActivitiesForToday' | 'withTasksOnControl' | 'failedToday' | 'failedFromSaleToday'
  | 'failedFromSaleThisWeek' | 'allSales' | 'updTasks';

export interface ColumnDef {
  key: ColumnKey;
  title: string;
  kind: 'deals' | 'tasks';
  /** Циклы, в которых колонка видна; null — «всегда» (без отметки цикла в Битриксе). */
  cycle: CycleKey[] | null;
  /** Цвет шапки (CSS-цвет из конфига Битрикса); null — нейтральный. */
  color: string | null;
  /** «light» в конфиге Битрикса — тёмный текст на светлой шапке. */
  light: boolean;
  /** Считается ли колонка в Монолитике. false — стоит на месте, пустая, с пометкой. */
  computed: boolean;
  /** Одна фраза «почему не считается» (только при computed=false). */
  missing?: string;
}

const WHY_ACTIVITIES = 'нужны актуальные дела по сделке, а в sa они лежат снимком на момент последнего изменения сделки';
const WHY_HISTORY = 'нужны дела по сделке и история покупок клиента, а дела в sa устаревают';
const WHY_PRODUCTS = 'правка товаров без смены сделки в sa не приходит';

const c = (
  key: ColumnKey, title: string, kind: 'deals' | 'tasks', cycle: CycleKey[] | null,
  color: string | null, light: boolean, missing?: string,
): ColumnDef => ({ key, title, kind, cycle, color, light, computed: !missing, ...(missing ? { missing } : {}) });

// CSS-цвета из конфига Битрикса (имена → hex).
const FIREBRICK = '#b22222', DARKBLUE = '#00008b', DARKSEAGREEN = '#8fbc8f', LIGHTSKYBLUE = '#87cefa', SEAGREEN = '#2e8b57',
  GOLDENROD = '#daa520', TEAL = '#008080', DARKGOLDENROD = '#b8860b', DARKCYAN = '#008b8b', MIDNIGHTBLUE = '#191970', GREEN = '#008000';

export const COLUMNS: readonly ColumnDef[] = [
  c('unprocessedDeals', 'Необработанные', 'deals', null, FIREBRICK, false),
  c('noActivities', 'Без дел', 'deals', null, null, false, WHY_ACTIVITIES),
  c('reservedWithActivitiesForToday', 'Брони с делами на сегодня', 'deals', ['ONE'], DARKBLUE, false, WHY_ACTIVITIES),
  c('confirmedReservedWithActivitiesForToday', 'Подтв. брони с делами на сегодня', 'deals', ['ONE'], DARKSEAGREEN, true, WHY_ACTIVITIES),
  c('betterPrice', 'Есть цена дешевле', 'deals', null, LIGHTSKYBLUE, true),
  c('logistRequest', 'Запрос логисту', 'deals', null, LIGHTSKYBLUE, true),
  c('shipmentToday', 'Продано, отгружается сегодня', 'deals', ['END'], SEAGREEN, false, WHY_ACTIVITIES),
  c('logistNotAnswered', 'Логист не ответил', 'deals', null, null, false),
  c('withBigDealsTasks', 'Большие сделки', 'deals', ['OTHER'], null, false),
  c('stageCalled', 'Созвонился и озвучил', 'deals', ['TWO'], GOLDENROD, true, WHY_ACTIVITIES),
  c('repeatedSaleImportant', 'Выйти на повторную продажу', 'deals', ['TWO'], TEAL, false, WHY_HISTORY),
  c('unprocessedSecondary', 'Необработанные повторные', 'deals', ['THREE'], DARKGOLDENROD, false, WHY_HISTORY),
  c('regularClients', 'Постоянные клиенты', 'deals', ['TWO'], DARKCYAN, false, WHY_HISTORY),
  c('stageCalledLowPriority', 'Созвонился и озвучил', 'deals', ['THREE'], GOLDENROD, true, WHY_ACTIVITIES),
  c('secondaryToday', 'Повторные на сегодня', 'deals', ['THREE'], MIDNIGHTBLUE, false, WHY_HISTORY),
  c('shipmentTomorrow', 'Продано, отгружается завтра', 'deals', ['ONE', 'THREE'], DARKSEAGREEN, true, WHY_ACTIVITIES),
  c('withRepeatingDealsTasks', 'Повторные сделки', 'deals', ['THREE'], null, false),
  c('debtTasks', 'Клиенты Долги', 'tasks', ['END'], null, false),
  c('callerIssuesTasks', 'Проблемы коллеры', 'tasks', ['END'], null, false),
  c('newDeals', 'Созданы сегодня', 'deals', ['TWO', 'THREE'], null, false),
  c('noProducts', 'Без товаров', 'deals', ['END'], null, false, WHY_PRODUCTS),
  c('withExpiredActivities', 'С просроченными делами', 'deals', ['END'], null, false, WHY_ACTIVITIES),
  c('withActivitiesForToday', 'С делами на сегодня', 'deals', ['END'], null, false, WHY_ACTIVITIES),
  c('withTasksOnControl', 'Ответ логиста не принят', 'deals', ['END'], null, false),
  c('failedToday', 'Отказы за сегодня', 'deals', ['OTHER'], null, false),
  c('failedFromSaleToday', 'Отказы из продаж (сегодня)', 'deals', ['OTHER'], null, false),
  c('failedFromSaleThisWeek', 'Отказы из продаж (7 дней)', 'deals', ['OTHER'], null, false),
  c('allSales', 'Все продажи', 'deals', ['OTHER'], GREEN, false),
  c('updTasks', 'Клиенты УПД', 'tasks', null, null, false),
];

/** Колонки, видимые во вкладке: «всегда» + отмеченные этим циклом; ALL — все 29. Логика initColumns(). */
export function columnsForCycle(cycle: CycleParam): ColumnDef[] {
  if (cycle === CYCLE_ALL) return [...COLUMNS];
  return COLUMNS.filter(col => !col.cycle || col.cycle.includes(cycle));
}

/** Ссылка на сделку/задачу в Битриксе (только ссылка, в Битрикс ничего не пишем). */
export const BITRIX_PORTAL = 'https://td.monolit-crm.ru';
export const dealUrl = (id: number) => `${BITRIX_PORTAL}/crm/deal/details/${id}/`;
export const taskUrl = (groupId: number | null, id: number) =>
  groupId ? `${BITRIX_PORTAL}/workgroups/group/${groupId}/tasks/task/view/${id}/` : `${BITRIX_PORTAL}/company/personal/user/0/tasks/task/view/${id}/`;
