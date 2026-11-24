// «Увольнятор» (задача владельца 24.11): всё, что висит на аккаунте сотрудника в Битриксе,
// одним списком → правила «что сделать и на кого» → «Готово» → фоновый исполнитель вежливо
// (по одному вызову, с паузами, с возобновлением после рестарта) проводит это в Битриксе.
//
// ЖЁСТКОЕ ПРАВИЛО ВЛАДЕЛЬЦА: ответственный СДЕЛКИ меняется ТОЛЬКО бизнес-процессом Битрикса
// «Сменить ответственного» (REASSIGN_TEMPLATE_ID = 171, features/repeat-kanban/engine/createDeal.ts) —
// он перепривязывает сделку, контакт, почту и т.д. Прямой crm.deal.update ASSIGNED_BY_ID запрещён.
// Остальное (контакты, компании, лиды, задачи, дела) — обычными методами REST.
//
// Доступ — только Администратор, Директор и суперадмин (features/dismissal/access.ts).
//
// Этот файл — КОНТРАКТ между движком (features/dismissal/engine, app/api/dismissal) и UI
// (features/dismissal/ui). Менять — синхронно с обеих сторон.

/** Что лежит на аккаунте. Порядок массива = порядок исполнения (сделки первыми: БП 171 сам
 *  перепривязывает связанные контакты/компании, исполнитель потом пропускает уже переехавшее). */
export const DISMISSAL_KINDS = [
  'deal_open',        // открытые сделки (ответственный) — только через БП 171
  'deal_closed',      // закрытые сделки (выиграны/проиграны) — по умолчанию НЕ трогаем (история продаж)
  'lead',             // открытые лиды (ответственный)
  'contact',          // контакты (ответственный)
  'company',          // компании (ответственный)
  'task_responsible', // незавершённые задачи, где он исполнитель
  'task_creator',     // незавершённые задачи, где он постановщик (исполнитель — другой)
  'task_participant', // незавершённые задачи, где он соисполнитель или наблюдатель
  'activity',         // незавершённые дела CRM (звонки, встречи, to-do), где он ответственный
] as const;
export type DismissalKind = typeof DISMISSAL_KINDS[number];

export const DISMISSAL_KIND_LABELS: Record<DismissalKind, string> = {
  deal_open: 'Открытые сделки',
  deal_closed: 'Закрытые сделки',
  lead: 'Лиды',
  contact: 'Контакты',
  company: 'Компании',
  task_responsible: 'Задачи: исполнитель',
  task_creator: 'Задачи: постановщик',
  task_participant: 'Задачи: соисполнитель / наблюдатель',
  activity: 'Дела в CRM',
};

/**
 * transfer — передать (одному получателю; несколько получателей → по кругу, поровну);
 *            для task_participant — заменить уволенного на получателя в той же роли;
 * close    — закрыть: задачу завершить (task_responsible), дело — отметить выполненным (activity);
 * remove   — убрать уволенного из участников (только task_participant);
 * skip     — не трогать.
 */
export type DismissalAction = 'transfer' | 'close' | 'remove' | 'skip';

export const DISMISSAL_ACTION_LABELS: Record<DismissalAction, string> = {
  transfer: 'Передать',
  close: 'Закрыть / завершить',
  remove: 'Убрать из участников',
  skip: 'Не трогать',
};

/** Допустимые действия по виду; первое — действие по умолчанию. */
export const DISMISSAL_ALLOWED_ACTIONS: Record<DismissalKind, DismissalAction[]> = {
  deal_open: ['transfer', 'skip'],
  deal_closed: ['skip', 'transfer'],
  lead: ['transfer', 'skip'],
  contact: ['transfer', 'skip'],
  company: ['transfer', 'skip'],
  task_responsible: ['transfer', 'close', 'skip'],
  task_creator: ['transfer', 'skip'],
  task_participant: ['remove', 'transfer', 'skip'],
  activity: ['transfer', 'close', 'skip'],
};

/** Правило на весь вид. targets — Битрикс-id получателей (для transfer обязателен ≥1). */
export interface DismissalRule {
  action: DismissalAction;
  targets: number[];
  /** «Раскидать по отделу» (владелец 24.11): получатели = все АКТИВНЫЕ менеджеры этого отдела
   *  (без уволенного), поровну по кругу. Состав берётся в момент «Готово» (start), а не при
   *  сохранении плана; если задан — targets игнорируется. id — как в DismissalDepartment.id. */
  departmentId?: string | null;
}

/** Исключение для одной строки: своё действие и/или свой получатель. */
export interface DismissalOverride {
  action: DismissalAction;
  target?: number | null;
}

export interface DismissalPlan {
  rules: Partial<Record<DismissalKind, DismissalRule>>;
  /** ключ — DismissalItem.key */
  overrides: Record<string, DismissalOverride>;
  /** Комментарий для истории (зачем/кто решил) — попадает в журнал прогона. */
  note?: string;
}

/**
 * scanning — собираем, что на аккаунте (фон);
 * draft    — собрано, правила редактируются;
 * queued / running — исполняется; paused — остановлен руками, можно продолжить;
 * done — всё прошло (ошибки отдельных строк — в счётчиках, прогон всё равно done);
 * failed — упал целиком (ошибка сканирования / вебхука); cancelled — отменён.
 */
export type DismissalRunStatus = 'scanning' | 'draft' | 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export type DismissalItemStatus = 'pending' | 'done' | 'skipped' | 'error';

export interface DismissalItem {
  /** `${kind}:${entityId}` — уникален в прогоне */
  key: string;
  kind: DismissalKind;
  entityId: number;
  title: string;
  /** Ссылка на сущность в Битриксе */
  url: string | null;
  /** Короткие подробности для строки: стадия, сумма, срок задачи, роль в задаче и т.п. */
  subtitle: string | null;
  /** Итог исполнения (после «Готово»): какое действие, кому, статус, текст ошибки/пропуска. */
  action: DismissalAction | null;
  target: number | null;
  status: DismissalItemStatus;
  detail: string | null;
  doneAt: string | null;
}

export interface DismissalUser {
  bitrixId: number;
  name: string;
  position: string | null;
  department: string | null;
  /** id отдела (как в DismissalDepartment.id) — чтобы предложить «раскидать по его отделу» */
  departmentId: string | null;
  active: boolean;
}

/** Отдел для «раскидать по отделу»: активные менеджеры, на которых делить поровну. */
export interface DismissalDepartment {
  id: string;
  name: string;
  managers: DismissalUser[];
}

export interface DismissalCounts {
  total: number;
  pending: number;
  done: number;
  skipped: number;
  error: number;
  byKind: Partial<Record<DismissalKind, number>>;
}

export interface DismissalRunSummary {
  id: string;
  source: DismissalUser;
  status: DismissalRunStatus;
  createdByName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: DismissalCounts;
  error: string | null;
}

export interface DismissalRunDetail extends DismissalRunSummary {
  plan: DismissalPlan;
  items: DismissalItem[];
  /** Имена получателей, встречающихся в плане/строках (bitrixId → имя) */
  userNames: Record<number, string>;
}

// ── API (все — только для canUseDismissal) ──────────────────────────────────────────────────
// GET    /api/dismissal/users                       → { users: DismissalUser[] }   (вкл. уволенных)
// GET    /api/dismissal/departments                 → { departments: DismissalDepartment[] }  (только активные менеджеры)
// GET    /api/dismissal/runs                        → { runs: DismissalRunSummary[] }
// POST   /api/dismissal/runs        {sourceBitrixId} → { id }   (создаёт прогон status=scanning)
// GET    /api/dismissal/runs/[id]                   → DismissalRunDetail
// PATCH  /api/dismissal/runs/[id]   {plan}          → DismissalRunDetail   (только в draft)
// POST   /api/dismissal/runs/[id]/start             → DismissalRunDetail   (draft → queued; валидирует план)
// POST   /api/dismissal/runs/[id]/pause | resume | cancel | retry  → DismissalRunDetail
//        retry — строки со status=error снова в pending, прогон → queued
// POST   /api/dismissal/runs/[id]/rescan            → DismissalRunDetail   (только draft: пересобрать)
// Ошибки — { error: string } с 4xx/5xx.
