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
export type BigTodayKey = 'control' | 'new' | 'stuck' | 'lost_check' | 'related_answered';
export interface BigTodaySection { key: BigTodayKey; title: string; hint: string; cards: BigTaskCard[] }

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
}

/** GET /api/big-deals-kanban?group=74,81&manager=123&product=Газобетон&q=текст
 *  POST /api/big-deals-kanban/action — тело BigAction, ответ { ok: true, card?: BigTaskCard } | { error }. */
export type BigAction =
  | { type: 'move'; taskId: number; column: BigColumnKey }
  | { type: 'reassign'; taskId: number; responsibleId: string; comment?: string }
  | { type: 'comment'; taskId: number; text: string; attachments?: string[] }
  | { type: 'accept'; taskId: number }
  | { type: 'return'; taskId: number; comment: string; deadline?: string }
  | { type: 'complete'; taskId: number };
