// Задачник — контракт API между сессиями A (ядро), B (виды), C (форма), D (обучения).
// Источник правды по смыслу — ai_docs/fresh_docs/TASKER_SPEC.md.
// Файл без серверных импортов: безопасно тянуть и в клиентские компоненты.

// ── Справочники ─────────────────────────────────────────────────────────────

/** Группа темы — для группировки/фильтра на доске. */
export type TaskerMetricGroup = 'conversion' | 'check' | 'activity' | 'repeat';

export const TASKER_METRIC_GROUP_LABELS: Record<TaskerMetricGroup, string> = {
  conversion: 'Конверсии',
  check: 'Чеки',
  activity: 'Активность',
  repeat: 'Повторка',
};

/** Метрика из белого списка «прокачиваемых» (таблица tasker_metrics). */
export interface TaskerMetric {
  /** id метрики в движке отчётов (features/reports/engine/metrics). */
  id: string;
  label: string;
  group: TaskerMetricGroup;
  /** true — «больше = лучше», false — «меньше = лучше». */
  higherIsBetter: boolean;
  /** Формат значения для отображения. */
  format: 'percent' | 'money' | 'number';
  /** Тег задачи в Битриксе (тема). */
  tag: string;
  sortOrder: number;
}

/** Шаблон рекомендаций по метрике (tasker_templates). */
export interface TaskerTemplate {
  id: number;
  metricId: string;
  title: string;
  body: string;
  sortOrder: number;
}

// ── Снимок ──────────────────────────────────────────────────────────────────

export interface TaskerPeriod {
  /** YYYY-MM-DD включительно */
  from: string;
  /** YYYY-MM-DD включительно */
  to: string;
}

/** Снимок цифр по одному менеджеру на момент постановки (и он же — формат замера). */
export interface Snapshot {
  /** Значение менеджера за период (null — нет данных / знаменатель 0). */
  value: number | null;
  /** Среднее по отделу за тот же период = строка «Итого» отдела (взвешенное). */
  deptAvg: number | null;
  /** Собственное среднее менеджера за 6 полных месяцев до периода. */
  ownAvg6m: number | null;
  deptName: string | null;
  /** Знаменатель метрики ≥ 5 (иначе вердикт «мало данных»; ставить задачу можно). */
  enoughData: boolean;
  /** Знаменатель (для пояснения «мало данных»), если метрика — отношение. */
  denominator?: number | null;
}

// ── Задачи ──────────────────────────────────────────────────────────────────

/**
 * Статус для доски. Первые четыре — из Битрикса (живой tasks.task.list):
 * new (1/2), in_progress (3), awaiting_control (4), done (5; 6/7 — тоже done).
 * measuring — Битрикс-задача завершена, ждёт контрольной даты замера.
 * result — вердикт поставлен.
 */
export type TaskerStatus =
  | 'new'
  | 'in_progress'
  | 'awaiting_control'
  | 'done'
  | 'measuring'
  | 'result';

export const TASKER_STATUS_LABELS: Record<TaskerStatus, string> = {
  new: 'Новая',
  in_progress: 'В работе',
  awaiting_control: 'Ждёт контроля',
  done: 'Завершена',
  measuring: 'На замере',
  result: 'Итог',
};

/** Статусы, которые можно выставить из Монолитики (перетаскивание = смена в Битриксе). */
export type TaskerPatchableStatus = 'new' | 'in_progress' | 'awaiting_control' | 'done';

export type TaskerVerdict = 'achieved' | 'improved' | 'no_change' | 'not_enough_data';

export const TASKER_VERDICT_LABELS: Record<TaskerVerdict, string> = {
  achieved: 'Достигнуто',
  improved: 'Рост, не дотянул',
  no_change: 'Без изменений',
  not_enough_data: 'Мало данных',
};

/** Состояние синхронизации с Битриксом (outbox). */
export type TaskerSyncState = 'pending' | 'synced' | 'failed';

export interface TaskerPerson {
  /** id менеджера в оргструктуре (= Bitrix user id). */
  id: number;
  name: string;
}

export interface TaskerChecklistItem {
  clientKey: string;
  title: string;
  /** Ссылка на CRM-сущность заказчика (если есть). */
  crmUrl?: string | null;
  done?: boolean;
}

export interface TaskerTask {
  id: number;
  bitrixTaskId: number | null;
  /** https://…/company/personal/user/…/tasks/task/view/ID/ — если задача уже в Битриксе. */
  bitrixUrl: string | null;
  syncState: TaskerSyncState;
  syncError: string | null;

  title: string;
  body: string;
  manager: TaskerPerson;
  rop: TaskerPerson | null;
  director: TaskerPerson | null;
  creator: TaskerPerson;
  departmentName: string | null;

  metricId: string;
  metricLabel: string;
  metricGroup: TaskerMetricGroup;
  higherIsBetter: boolean;
  format: TaskerMetric['format'];

  period: TaskerPeriod;
  snapshot: Snapshot;
  target: number | null;
  templateId: number | null;

  /** ISO datetime */
  deadline: string;
  durationMin: number;
  /** Плановый слот (START_DATE_PLAN), ISO datetime. */
  slotStart: string | null;
  slotEnd: string | null;
  /** YYYY-MM-DD — дата автозамера. */
  controlDate: string;

  status: TaskerStatus;
  /** Сырой статус Битрикса (1..7), если известен. */
  bitrixStatus: number | null;
  closedAt: string | null;

  verdict: TaskerVerdict | null;
  /** Значение на замере (тот же формат, что snapshot.value). */
  measuredValue: number | null;
  measuredAt: string | null;

  sessionId: number | null;
  trainingEventId: number | null;
  checklist: TaskerChecklistItem[];

  createdAt: string;
}

// ── Сессии ──────────────────────────────────────────────────────────────────

/** Сессия = встреча РОПа по одной теме (метрике) с несколькими менеджерами. */
export interface TaskerSession {
  id: number;
  rop: TaskerPerson;
  metricId: string;
  metricLabel: string;
  /** ISO datetime */
  slotStart: string;
  /** 30 мин + 15 мин на каждого следующего менеджера. */
  durationMin: number;
  calendarEventId: number | null;
  taskIds: number[];
  managers: TaskerPerson[];
}

// ── Обучения (сессия D; здесь — минимальная форма для ответа /tasks) ─────────

export interface TrainingEnrollment {
  eventId: number;
  title: string;
  /** ISO datetime */
  startsAt: string;
  durationMin: number;
  place: string | null;
  trainer: TaskerPerson | null;
  manager: TaskerPerson;
}

// ── Эндпоинты ───────────────────────────────────────────────────────────────

/** GET /api/tasker/tasks?view=board|week|today&from&to&managerId&ropId&metricId&mine=created|watch */
export type TaskerView = 'board' | 'week' | 'today';

export interface TaskerTasksQuery {
  view?: TaskerView;
  from?: string;
  to?: string;
  managerId?: number;
  ropId?: number;
  metricId?: string;
  mine?: 'created' | 'watch';
}

export interface TaskerTasksResponse {
  tasks: TaskerTask[];
  sessions: TaskerSession[];
  trainings: TrainingEnrollment[];
}

/** POST /api/tasker/tasks */
export interface TaskerCreateRequest {
  managerIds: number[];
  metricId: string;
  period: TaskerPeriod;
  /** Цель; по умолчанию — среднее отдела из снимка (у каждого менеджера своё). */
  target?: number | null;
  /** Тело рекомендаций (обычный текст; BB-код допустим). */
  body: string;
  templateId?: number | null;
  /** ISO datetime или YYYY-MM-DD (тогда 18:00 МСК). */
  deadline: string;
  durationMin: number;
  slot?: { start: string } | null;
  /** Добавить в существующую сессию… */
  sessionId?: number | null;
  /** …или завести новую (слот обязателен). */
  newSession?: boolean;
  /** YYYY-MM-DD */
  controlDate: string;
  /** clientKey из GET /api/tasker/customers. Применяется к каждому менеджеру — берутся только его заказчики. */
  customersChecklist?: string[];
  trainingEventId?: number | null;
  /** Директор/админ: обойти лимит «≤3 открытых» (дубль метрики не обходится). */
  overrideLimits?: boolean;
}

export type TaskerWarningCode =
  | 'limit_open_tasks'
  | 'duplicate_metric'
  | 'not_enough_data'
  | 'bitrix_failed'
  | 'forbidden_manager'
  | 'no_snapshot';

export interface TaskerWarning {
  managerId: number | null;
  code: TaskerWarningCode;
  message: string;
}

export interface TaskerCreateResponse {
  created: TaskerTask[];
  warnings: TaskerWarning[];
}

/** PATCH /api/tasker/tasks/:id */
export interface TaskerPatchRequest {
  status?: TaskerPatchableStatus;
  slot?: { start: string } | null;
  deadline?: string;
}

export interface TaskerPatchResponse {
  task: TaskerTask;
}

/** POST /api/tasker/snapshot */
export interface TaskerSnapshotRequest {
  managerIds: number[];
  metricId: string;
  period: TaskerPeriod;
}

/** Ключ — managerId строкой (JSON). */
export type TaskerSnapshotResponse = Record<string, Snapshot>;

/** GET /api/tasker/metrics */
export interface TaskerMetricsResponse {
  metrics: TaskerMetric[];
  /** false — group_id проекта Задачника в Битриксе ещё не задан, создание вернёт ошибку. */
  bitrixConfigured: boolean;
}

/** GET /api/tasker/templates?metricId */
export interface TaskerTemplatesResponse {
  templates: TaskerTemplate[];
}

/** GET /api/tasker/customers?managerId — открытое окно (22 дня) + ровно 1 отгрузка. */
export interface TaskerCustomer {
  clientKey: string;
  title: string;
  crmUrl: string | null;
  /** Дата первой (единственной) отгрузки, YYYY-MM-DD. */
  shippedAt: string | null;
  /** Сколько дней осталось в окне. */
  daysLeft: number | null;
  revenue: number | null;
}

export interface TaskerCustomersResponse {
  customers: TaskerCustomer[];
}

/** GET /api/tasker/sessions?ropId&metricId&from&to */
export interface TaskerSessionsResponse {
  sessions: TaskerSession[];
}

/** Тело ошибки любого эндпоинта. code='not_configured' — не задан проект Задачника. */
export interface TaskerErrorResponse {
  error: string;
  code?: 'not_configured' | 'forbidden' | 'bad_request' | 'limit' | 'bitrix';
}
