// КОНТРАКТ между движком (engine/*, app/api/big-deals-kanban/route.ts), экраном (ui/BigDealsKanbanPage.tsx)
// и карточкой задачи/действиями (ui/TaskDrawer.tsx, app/api/big-deals-kanban/action/route.ts).
// Меняешь — согласуй с остальными частями (BIG_DEALS_KANBAN_SPEC.md).
import type { BigColumnKey } from './config';

/** Статус задачи для карточки. Битрикс: 1 новая, 2 ждёт выполнения, 3 выполняется, 4 ждёт контроля,
 *  5 завершена, 6 отложена; «не просмотрена» — subStatus -2 / status_view -2. */
export type BigTaskState = 'unread' | 'pending' | 'in_progress' | 'control' | 'done' | 'deferred';

export interface BigPerson { id: string; name: string }

export interface BigDealInfo {
  id: number;
  title: string;
  /** OPPORTUNITY сделки, ₽. */
  amount: number;
  stageId: string;
  stageName: string;
  /** Сделка закрыта: won | lost | null (в работе). */
  closed: 'won' | 'lost' | null;
  assigned: BigPerson | null;
  contactId: number | null;
  companyId: number | null;
  url: string;
}

export interface BigCallStats {
  /** Звонков по сделке после постановки задачи (va.calls, failed_at_stage IS NULL). */
  total: number;
  /** Из них разговоров > 20 с. */
  talks: number;
  /** Суммарная длительность разговоров, с. */
  talkSeconds: number;
  lastAt: string | null;
}

/** Связанная задача по той же сделке ВНЕ проектов больших сделок (логист, снабженец, «есть дешевле»…). */
export interface BigRelatedTask {
  id: number;
  title: string;
  groupName: string | null;
  state: BigTaskState;
  responsible: BigPerson | null;
  changedAt: string | null;
  url: string;
}

export interface BigTaskCard {
  id: number;
  title: string;
  groupId: number;
  groupShort: string;
  /** Стадия проекта в Битриксе (id и исходное название) и колонка общей сетки. */
  stageId: number;
  stageTitle: string;
  column: BigColumnKey;
  state: BigTaskState;
  responsible: BigPerson;
  creator: BigPerson;
  auditors: string[];
  createdAt: string;
  changedAt: string | null;
  closedAt: string | null;
  deadlineAt: string | null;
  /** Когда задача попала в текущую колонку (свой журнал в Redis; до первого наблюдения — changedAt/createdAt). */
  inColumnSince: string;
  daysInColumn: number;
  /** Дольше порога STUCK_DAYS. */
  stuck: boolean;
  /** Товарная группа сделки (sa.deals.head_group_name, решение владельца 18.11); БД недоступна — часть названия задачи до «|». */
  productGroup: string | null;
  /** Все товарные группы сделки (head-группа + группы товаров, без услуг/доставки) — для фильтра. */
  productGroups: string[];
  /** Сумма из задачи (поле «Общая сумма» описания), если сделки нет. */
  taskAmount: number | null;
  /** Клиент из описания задачи («Клиент: …») — для поиска и показа. */
  client?: string | null;
  deal: BigDealInfo | null;
  calls: BigCallStats | null;
  related: BigRelatedTask[];
  url: string;
}

export interface BigColumnData {
  key: BigColumnKey;
  title: string;
  hint?: string;
  color: string;
  total: number;
  /** Сумма сделок колонки. */
  sum: number;
  cards: BigTaskCard[];
  /** Проекты, у которых ЕСТЬ стадия этой колонки (куда можно перетащить). */
  groupIds: number[];
}

/** Секции вкладки «Сегодня» — что делать прямо сейчас. */
/** Порядок (владелец 18.11, встреча 11.11): ждут контроля → почти продано (подтверждённая бронь, бронь, счёт) →
 *  новые → застряли → не продано на проверку → ответили по связанной. Свои колонки — `custom:<id>`. */
export type BigTodayKey = 'control' | 'almost_sold' | 'new' | 'stuck' | 'lost_check' | 'related_answered' | `custom:${string}`;
export interface BigTodaySection {
  key: BigTodayKey; title: string; hint: string; cards: BigTaskCard[];
  /** Всего подходящих (cards может быть урезан). */
  total: number;
  /** Сумма сделок секции. */
  sum: number;
  /** Своя колонка пользователя. */
  custom?: BigCustomColumn;
}

/** Фильтры доски (query GET /api/big-deals-kanban) — те же условия используют свои колонки и массовое закрытие. */
export interface BigFilters {
  groups?: number[];
  manager?: string | null;
  /** Товарные группы сделки — через «|» в query. */
  products?: string[];
  q?: string | null;
  /** Сумма сделки (или задачи), ₽. */
  sumMin?: number | null; sumMax?: number | null;
  /** Дата создания задачи YYYY-MM-DD, включительно. */
  createdFrom?: string | null; createdTo?: string | null;
  /** Статусы задачи. */
  states?: BigTaskState[];
  /** Колонки доски (для своих колонок и массового закрытия). */
  columns?: BigColumnKey[];
  /** Дней в колонке не меньше. */
  daysMin?: number | null;
  /** Не менялась (changedAt) дней не меньше — для разбора завалов. */
  idleDaysMin?: number | null;
  stuck?: boolean;
  /** Звонков после постановки не было. */
  noCalls?: boolean;
  /** Скрыть колонки «Не продано (проверка/проверено)» — кнопка «Ждёт контроля» (владелец 18.11: там тысячи старых отказов). Query nolost=1. */
  hideLost?: boolean;
  /** Сделка: won | lost | open. */
  deal?: 'won' | 'lost' | 'open' | null;
}
export type BigSort = 'default' | 'sum' | 'days' | 'created' | 'idle';

/** Своя колонка «Сегодня» (как в повторке): набор условий BigFilters, хранится в users.ui_prefs.bigDealsColumns (без миграции). */
export interface BigCustomColumn { id: string; name: string; filters: BigFilters; createdAt: string }

export interface BigBoardResponse {
  columns: BigColumnData[];
  today: BigTodaySection[];
  /** Фильтры: что есть в данных. */
  managers: BigPerson[];
  productGroups: string[];
  groups: { id: number; short: string; name: string }[];
  /** Может ли пользователь двигать/переназначать (РОП/директор/админ), а не только смотреть свои. */
  canManage: boolean;
  me: string | null;
  generatedAt: string;
  /** Данные из кэша старше 3 мин (идёт фоновое обновление). */
  stale: boolean;
  /** Свои колонки пользователя (для редактирования). */
  customColumns: BigCustomColumn[];
}

/** Аналитика по менеджерам (встреча 11.11: «сколько больших задач, продано, проебано, конверсия — подсветить низкую»).
 *  GET /api/big-deals-kanban/analytics?<те же фильтры>&from=YYYY-MM-DD&to=YYYY-MM-DD (по дате создания задачи). */
export interface BigManagerStat {
  manager: BigPerson;
  tasks: number; open: number; sold: number; lost: number;
  /** sold / (sold + lost), null — закрытых нет. */
  conversion: number | null;
  soldSum: number; openSum: number;
  /** Среднее звонков после постановки на задачу. */
  callsPerTask: number | null;
}
/** Разрез аналитики (владелец 18.11): по исполнителю — кто хорошо выполняет, по постановщику — кто хорошо ставит задачи,
 *  по назначившему — кто сменил исполнителя на текущего (история задачи; без смены — постановщик). */
export type BigAnalyticsBy = 'responsible' | 'creator' | 'assigner';
export interface BigAnalyticsResponse {
  from: string; to: string; by: BigAnalyticsBy; total: BigManagerStat; managers: BigManagerStat[]; avgConversion: number | null;
  /** by=assigner: у скольких задач история ещё догружается в фоне (они пока не в таблице). */
  pending?: number;
  /** by=assigner: задач, где исполнителя назначили сменой (а не сразу при создании). */
  reassigned?: number;
}

/** Массовое закрытие (владелец 18.11). POST /api/big-deals-kanban/mass-close
 *  { taskIds: number[] } | { filters: BigFilters } + { dryRun?: boolean, comment?: string } →
 *  dryRun: { count, sample: BigTaskCard[] }; иначе { jobId } — опрос GET /api/big-deals-kanban/mass-close?job=<id> → BigMassCloseJob. */
export interface BigMassCloseJob { id: string; total: number; done: number; failed: number; errors: string[]; finished: boolean; startedAt: string }

/** GET /api/big-deals-kanban?group=74,81&manager=123&product=Газобетон&q=текст
 *  POST /api/big-deals-kanban/action — тело BigAction, ответ { ok: true, card?: BigTaskCard } | { error }. */
export type BigAction =
  | { type: 'move'; taskId: number; column: BigColumnKey }
  | { type: 'reassign'; taskId: number; responsibleId: string; comment?: string }
  | { type: 'comment'; taskId: number; text: string; attachments?: string[] }
  /** «Ответ увидел, работаем дальше» (владелец 18.11): НЕ закрывает задачу — возвращает в работу с комментарием, срок по желанию. */
  | { type: 'accept'; taskId: number; comment?: string; deadline?: string }
  /** Наблюдатели/соисполнители (встреча: «подключаем РОПа в наблюдатели»). */
  | { type: 'participants'; taskId: number; auditors: string[]; accomplices?: string[] }
  | { type: 'return'; taskId: number; comment: string; deadline?: string }
  | { type: 'complete'; taskId: number }
  /** Возобновить завершённую задачу (РОП 18.11): tasks.task.renew + обязательный новый срок, комментарий кто и до какого. */
  | { type: 'renew'; taskId: number; deadline: string; comment?: string }
  /** Поставить/перенести срок открытой задачи (tasks.task.update DEADLINE). */
  | { type: 'deadline'; taskId: number; deadline: string };
