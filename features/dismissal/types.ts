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

// ── v2 (правка владельца 24.11, после первой выкатки) ─────────────────────────────────────────
// • сделки делятся на ПЕРВИЧКУ и ПОВТОРКУ; лиды, контакты, компании НЕ трогаем отдельно — БП 171 сам
//   меняет ответственного у компании, контакта, лида и у дел сделки (проверено по шаблону 24.11);
// • повторка ранжируется по LTV заказчика, затем по числу отгрузок; топ клиентов — отдельным блоком;
// • первичка передаётся, только если «бронь+» (стадия с event_type reserved/confirmed/sold) ИЛИ чек ≥ 100 000;
//   остальное — в автобрак (стадия «НЕ ТРОГАТЬ - ЗАПРЕЩЕНО»: ЧЛ '9', ЮЛ 'C1:9'; в воронках без такой стадии —
//   Холодные 4, Тендеры 7 — автобрака нет, неквалифицированные по умолчанию передаются);
// • БП 171 задачи сделки НЕ передаёт (задачи роботов в ЧЛ/ЮЛ он завершает) — открытые задачи, привязанные к сделке,
//   Увольнятор сам передаёт ВСЛЕД ЗА СДЕЛКОЙ (тот же получатель; сделка в автобраке — задачу закрыть);
// • задачи/дела, не связанные с его открытыми сделками (УПД и т.п.), — на РОПа + сообщение РОПу со ссылками;
// • в конце — сообщение и автозадача Анне Кузнецовой (PASSWORD_RESET_BITRIX_ID) сменить пароль на аккаунте.

/** Ассистент CEO, Анна Кузнецова — ей сообщение и задача «сменить пароль на аккаунте уволенного». */
export const PASSWORD_RESET_BITRIX_ID = 2096;
/** Порог чека первички «передаём, даже если не бронь» (₽, сумма сделки). */
export const PRIMARY_MIN_AMOUNT = 100_000;
/** Сколько повторных заказчиков по умолчанию в блоке «Топ клиентов». */
export const DEFAULT_TOP_COUNT = 20;
/** Стадии автобрака первички по воронкам. Нет ключа — автобрака в воронке нет. */
export const PRIMARY_BRAK_STAGE: Record<number, string> = { 0: '9', 1: 'C1:9' };
/** v3: «закрыть» оставшуюся повторку — отказная стадия по причине, как «брак» канбана повторных
 *  (LOST_STAGE_BY_REASON в features/repeat-kanban/engine/createDeal.ts; держать синхронно). Заказчика при этом
 *  НЕ помечаем «не звонить» — закрывается только сделка уволенного. */
export const REPEAT_BRAK_REASONS = [
  { value: 'nothing_needed', label: 'Больше ничего не нужно' },
  { value: 'no_objects', label: 'Объектов больше нет' },
  { value: 'expensive', label: 'Дорого, предложил другие материалы, больше ничего не нужно' },
  { value: 'failed_client', label: 'Подвели клиента — не хочет с нами работать' },
] as const;
export type RepeatBrakReason = (typeof REPEAT_BRAK_REASONS)[number]['value'];
export const REPEAT_BRAK_STAGE: Record<2 | 3, Record<RepeatBrakReason, string>> = {
  2: { no_objects: 'C2:APOLOGY', nothing_needed: 'C2:APOLOGY', expensive: 'C2:LOSE', failed_client: 'C2:1' },
  3: { no_objects: 'C3:2', nothing_needed: 'C3:2', expensive: 'C3:LOSE', failed_client: 'C3:APOLOGY' },
};
export const PRIMARY_FUNNELS = [0, 1, 4, 7] as const;
export const REPEAT_FUNNELS = [2, 3] as const;

/** Что лежит на аккаунте. Порядок массива = порядок исполнения (сделки первыми: задачи и дела сделок
 *  идут следом за ними; дела БП 171 уже перевёл сам — исполнитель такие отметит «уже у получателя»). */
export const DISMISSAL_KINDS = [
  'deal_primary',     // открытые сделки первичных воронок (0, 1, 4, 7)
  'deal_repeat',      // открытые сделки повторных воронок (2, 3), ранжированы по LTV/отгрузкам
  'task_deal',        // его незавершённые задачи (исполнитель), привязанные к его открытой сделке из прогона
  'activity_deal',    // его незакрытые дела в его открытых сделках из прогона
  'task_other',       // его задачи (исполнитель), НЕ привязанные к его открытым сделкам — на РОПа
  'activity_other',   // его дела вне его открытых сделок — на РОПа
  'task_creator',     // задачи, где он постановщик (исполнитель — другой) — постановщиком РОПа
  'task_participant', // задачи, где он соисполнитель / наблюдатель — убрать
] as const;
export type DismissalKind = typeof DISMISSAL_KINDS[number];

export const DISMISSAL_KIND_LABELS: Record<DismissalKind, string> = {
  deal_primary: 'Первичные сделки',
  deal_repeat: 'Повторные сделки',
  task_deal: 'Задачи по сделкам',
  activity_deal: 'Дела по сделкам',
  task_other: 'Задачи без сделок',
  activity_other: 'Дела без сделок',
  task_creator: 'Задачи: он постановщик',
  task_participant: 'Задачи: соисполнитель / наблюдатель',
};

/**
 * transfer — передать (несколько получателей → по кругу; повторка — «змейкой» по рангу, чтобы LTV делился ровно);
 *            для task_participant — заменить уволенного на получателя в той же роли;
 * brak     — первичка в автобрак: стадия PRIMARY_BRAK_STAGE[воронка]; повторка (v3) — «закрыть»:
 *            REPEAT_BRAK_STAGE[воронка][plan.repeatBrakReason]; crm.deal.update STAGE_ID
 *            (ответственный при этом НЕ меняется — БП не запускается);
 * follow   — вслед за сделкой (task_deal / activity_deal): получатель = получатель сделки; сделка в brak —
 *            задача завершается / дело закрывается; сделка skip — тоже skip. Разворачивается в start;
 * close    — задачу завершить / дело отметить выполненным;
 * remove   — убрать уволенного из участников (task_participant);
 * skip     — не трогать.
 */
export type DismissalAction = 'transfer' | 'brak' | 'follow' | 'close' | 'remove' | 'skip';

export const DISMISSAL_ACTION_LABELS: Record<DismissalAction, string> = {
  transfer: 'Передать',
  brak: 'В автобрак',
  follow: 'Вслед за сделкой',
  close: 'Закрыть / завершить',
  remove: 'Убрать из участников',
  skip: 'Не трогать',
};

/** Допустимые действия по виду; первое — по умолчанию. Для deal_primary умолчание — ПО СТРОКЕ:
 *  qualified → transfer, иначе brak (если в воронке есть стадия автобрака), иначе transfer.
 *  brak для строки без стадии автобрака — ошибка валидации. */
export const DISMISSAL_ALLOWED_ACTIONS: Record<DismissalKind, DismissalAction[]> = {
  deal_primary: ['transfer', 'brak', 'skip'],
  deal_repeat: ['transfer', 'brak', 'skip'],
  task_deal: ['follow', 'close', 'skip'],
  activity_deal: ['follow', 'close', 'skip'],
  task_other: ['transfer', 'close', 'skip'],
  activity_other: ['transfer', 'close', 'skip'],
  task_creator: ['transfer', 'skip'],
  task_participant: ['remove', 'transfer', 'skip'],
};

/** Правило на весь вид. targets — Битрикс-id получателей. Для task_other / activity_other / task_creator
 *  пустые targets при transfer = РОП (plan.ropBitrixId). */
export interface DismissalRule {
  action: DismissalAction;
  targets: number[];
  /** «Раскидать по отделу»: получатели = все АКТИВНЫЕ менеджеры отдела (без уволенного), состав — в момент start;
   *  если задан — targets игнорируется. id — как в DismissalDepartment.id. */
  departmentId?: string | null;
}

/** Исключение для одной строки: своё действие и/или свой получатель (для топ-клиентов — ручной выбор). */
export interface DismissalOverride {
  action: DismissalAction;
  target?: number | null;
}

export interface DismissalPlan {
  rules: Partial<Record<DismissalKind, DismissalRule>>;
  /** ключ — DismissalItem.key */
  overrides: Record<string, DismissalOverride>;
  /** Размер блока «Топ клиентов» (заказчиков, не сделок), по умолчанию DEFAULT_TOP_COUNT. Топ без ручного
   *  получателя распределяется вместе с остальными по правилу deal_repeat. */
  topCount?: number;
  /** РОП уволенного: получатель задач/дел без сделок и адресат сообщения. Сканирование подставляет
   *  автоматически (ropOfManager), UI даёт поменять. */
  ropBitrixId?: number | null;
  /** Сообщение РОПу со ссылками на задачи без сделок (по умолчанию true). */
  notifyRop?: boolean;
  /** Сообщение + задача Кузнецовой сменить пароль (по умолчанию true). */
  passwordReset?: boolean;
  /** v3: причина закрытия оставшейся повторки (action brak у deal_repeat), по умолчанию 'nothing_needed'. */
  repeatBrakReason?: RepeatBrakReason;
  note?: string;
}

/** Подробности строки для показа и решений (заполняет сканирование). */
export interface DismissalItemInfo {
  funnelId?: number;
  stageName?: string;
  amount?: number | null;
  /** deal_primary: проходит ли критерий «бронь+ или чек ≥ PRIMARY_MIN_AMOUNT» и почему */
  qualified?: boolean;
  qualifyReason?: string;
  /** deal_primary: есть ли в воронке стадия автобрака */
  brakAvailable?: boolean;
  /** deal_repeat: заказчик и его ценность */
  clientKey?: string;
  clientName?: string;
  ltv?: number;
  shipments?: number;
  /** ранг заказчика (1 — лучший); несколько сделок одного заказчика — один ранг */
  rank?: number;
  /** task_deal / activity_deal: ключ сделки в прогоне (`deal_primary:123` / `deal_repeat:123`) */
  dealKey?: string;
  /** задачи: крайний срок, роль */
  deadline?: string | null;
  role?: string;
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
  info: DismissalItemInfo;
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
  /** v3: можно ли текущему пользователю запустить Увольнятор на этого сотрудника (выбор «кого увольняем»). */
  dismissable: boolean;
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

/** Завершающие шаги прогона (после всех строк). */
export interface DismissalFinals {
  ropMessage: { status: 'pending' | 'done' | 'skipped' | 'error'; detail: string | null };
  passwordReset: { status: 'pending' | 'done' | 'skipped' | 'error'; detail: string | null; taskId: number | null; taskUrl?: string | null };
}

export interface DismissalRunDetail extends DismissalRunSummary {
  plan: DismissalPlan;
  /** Когда закончен последний сбор (после «Пересобрать» — новая дата); null — ещё собирается. */
  scannedAt: string | null;
  /** РОП, определённый при сканировании (может быть null — тогда UI требует выбрать) */
  rop: DismissalUser | null;
  finals: DismissalFinals;
  items: DismissalItem[];
  /** Имена получателей, встречающихся в плане/строках (bitrixId → имя) */
  userNames: Record<number, string>;
}

// ── Доступ по иерархии (v3, владелец 24.11: «запускать можно только на подчинённых») ────────────
// Кого увольнять: Директор — только сотрудников своего среза (getSessionScope/canSeeManager, lib/org/sessionScope.ts);
// Администратор/суперадмин — всех, КРОМЕ администраторов и суперадминов (по users Монолитики, роль/флаг) и себя.
// Себя — никогда. Получатели (люди и отделы) — тоже в пределах среза инициатора; РОП уволенного — всегда допустим.
// Прогоны: список и любой доступ к прогону (GET/PATCH/команды) — только если source в срезе инициатора, иначе 404.
// Проверка — на сервере во ВСЕХ роутах; UI лишь не предлагает недоступных (dismissable=false не выбрать).

// ── API (все — только для canUseDismissal) ──────────────────────────────────────────────────
// GET    /api/dismissal/users                       → { users: DismissalUser[] }   (вкл. уволенных; только в срезе инициатора, dismissable — кого можно увольнять)
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
