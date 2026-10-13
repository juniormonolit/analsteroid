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

/** Сколько карточек одной колонки отдаём на экран (остальное — в счётчике «показано N из M»). */
export const CARDS_PER_COLUMN = 100;

export type ColumnKey =
  | 'unprocessedDeals' | 'newDeals' | 'logistRequest' | 'betterPrice' | 'logistNotAnswered'
  | 'withTasksOnControl' | 'withBigDealsTasks' | 'withRepeatingDealsTasks'
  | 'debtTasks' | 'updTasks' | 'callerIssuesTasks'
  | 'failedToday' | 'failedFromSaleToday' | 'failedFromSaleThisWeek' | 'allSales';

export type ColumnGroup = 'work' | 'logist' | 'tasks' | 'result';

export interface ColumnDef {
  key: ColumnKey;
  title: string;
  kind: 'deals' | 'tasks';
  group: ColumnGroup;
  /** Тон полоски колонки (CSS-токен в UI). */
  tone: 'neutral' | 'negative' | 'warning' | 'positive' | 'accent';
  /** Подсказка под заголовком — коротко, как колонка считается. */
  hint: string;
}

/** Порядок — как в SalesKanbanConfig::getColumns('default') для колонок первой партии. */
export const COLUMNS: readonly ColumnDef[] = [
  { key: 'unprocessedDeals', title: 'Необработанные', kind: 'deals', group: 'work', tone: 'negative', hint: 'Первичные сделки на стадии «Срочно обработать»' },
  { key: 'newDeals', title: 'Созданы сегодня', kind: 'deals', group: 'work', tone: 'accent', hint: 'Первичные сделки, созданные с 00:00 МСК' },
  { key: 'betterPrice', title: 'Есть цена дешевле', kind: 'deals', group: 'logist', tone: 'warning', hint: 'Стадия «цена дешевле» и есть ответ логиста за 14 дней' },
  { key: 'logistRequest', title: 'Запрос логисту', kind: 'deals', group: 'logist', tone: 'accent', hint: 'Стадия запроса и есть ответ логиста за 14 дней' },
  { key: 'logistNotAnswered', title: 'Логист не ответил', kind: 'deals', group: 'logist', tone: 'negative', hint: 'Задача логисту открыта (14 дней), ответа ещё нет' },
  { key: 'withTasksOnControl', title: 'Ответ логиста не принят', kind: 'deals', group: 'logist', tone: 'warning', hint: 'Задача логисту ждёт контроля менеджера' },
  { key: 'withBigDealsTasks', title: 'Большие сделки', kind: 'deals', group: 'tasks', tone: 'accent', hint: 'Есть открытая задача в группах «Большие сделки»' },
  { key: 'withRepeatingDealsTasks', title: 'Повторные сделки', kind: 'deals', group: 'tasks', tone: 'accent', hint: 'Есть открытая задача в группах «Повторные продажи»' },
  { key: 'debtTasks', title: 'Клиенты Долги', kind: 'tasks', group: 'tasks', tone: 'warning', hint: 'Открытые задачи группы «Клиенты ДОЛГИ»' },
  { key: 'updTasks', title: 'Клиенты УПД', kind: 'tasks', group: 'tasks', tone: 'warning', hint: 'Открытые задачи группы «Клиенты УПД»' },
  { key: 'callerIssuesTasks', title: 'Проблемы коллеры', kind: 'tasks', group: 'tasks', tone: 'warning', hint: 'Открытые задачи группы «Проблемы коллеры»' },
  { key: 'failedToday', title: 'Отказы за сегодня', kind: 'deals', group: 'result', tone: 'neutral', hint: 'Сделки, закрытые отказом с 00:00 МСК' },
  { key: 'failedFromSaleToday', title: 'Отказы из продаж (сегодня)', kind: 'deals', group: 'result', tone: 'negative', hint: 'Отказ сегодня у сделки, которая раньше была «Продано»' },
  { key: 'failedFromSaleThisWeek', title: 'Отказы из продаж (7 дней)', kind: 'deals', group: 'result', tone: 'negative', hint: 'То же за последние 7 дней' },
  { key: 'allSales', title: 'Все продажи', kind: 'deals', group: 'result', tone: 'positive', hint: 'Сделки сейчас на стадии «Продано»' },
];

export const GROUP_TITLES: Record<ColumnGroup, string> = {
  work: 'Заявки', logist: 'Логисты', tasks: 'Задачи', result: 'Результат',
};

/** Ссылка на сделку/задачу в Битриксе (только ссылка, в Битрикс ничего не пишем). */
export const BITRIX_PORTAL = 'https://td.monolit-crm.ru';
export const dealUrl = (id: number) => `${BITRIX_PORTAL}/crm/deal/details/${id}/`;
export const taskUrl = (groupId: number | null, id: number) =>
  groupId ? `${BITRIX_PORTAL}/workgroups/group/${groupId}/tasks/task/view/${id}/` : `${BITRIX_PORTAL}/company/personal/user/0/tasks/task/view/${id}/`;
