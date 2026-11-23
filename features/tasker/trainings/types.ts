// Обучения Задачника (сессия D) — типы API /api/tasker/trainings/*.
// Без серверных импортов: тянется и в клиент. TrainingEnrollment (минимальная форма для
// /api/tasker/tasks и видов B) живёт в features/tasker/types.ts — здесь он переиспользуется.
import type { Snapshot, TaskerMetric, TaskerPerson, TaskerVerdict, TrainingEnrollment } from '../types';

export type { TrainingEnrollment };

export interface TrainingAttendee {
  manager: TaskerPerson;
  departmentName: string | null;
  enrolledBy: string | null;
  taskerTaskId: number | null;
  /** ISO datetime */
  enrolledAt: string;
  /** Текущий пользователь может отписать (видит менеджера / тренер). */
  canUnenroll: boolean;
  /** Цель записи: показатели (по умолчанию — показатели события) и «зачем отправили». */
  goalMetricIds: string[];
  goalNote: string | null;
  /** Записали из задачи — её показатель и снимок на момент постановки. */
  taskMetricId: string | null;
  taskSnapshot: Snapshot | null;
  /** Посещение: true — был, false — не был, null — не отмечено (в оценку не идёт). */
  attended: boolean | null;
  /** Замер по показателям (только у посетивших, после окна «после»). */
  results: TrainingResult[];
  /** Итог по человеку по всем его показателям; null — ещё не замерено. */
  outcome: TrainingOutcome | null;
}

/** Итог человека: вырос / без изменений / мало данных. */
export type TrainingOutcome = 'improved' | 'no_change' | 'not_enough_data';

export const TRAINING_OUTCOME_LABELS: Record<TrainingOutcome, string> = {
  improved: 'Вырос',
  no_change: 'Без изменений',
  not_enough_data: 'Мало данных',
};

/** Замер одного показателя у одного посетившего: N дней до события против N дней после. */
export interface TrainingResult {
  metricId: string;
  /** Окна, YYYY-MM-DD включительно. */
  before: { from: string; to: string };
  after: { from: string; to: string };
  valueBefore: number | null;
  valueAfter: number | null;
  /** Строка «Итого» отдела менеджера за те же окна — контроль («у менеджера +5 п.п., у отдела +1»). */
  deptBefore: number | null;
  deptAfter: number | null;
  deptName: string | null;
  /** Логика и пороги — verdictOf автозамера ядра (features/tasker/engine/measure.ts). null — замер не удался, повтор. */
  verdict: TaskerVerdict | null;
  error: string | null;
  measuredAt: string;
}

/** Сводка карточки события: «прошли 10, выросли у 8, без изм. 1, мало данных 1». Считается по видимым людям. */
export interface TrainingEffectSummary {
  attended: number;
  absent: number;
  /** Посещение не отмечено — в оценку не идёт. */
  unmarked: number;
  improved: number;
  noChange: number;
  notEnoughData: number;
  /** Посетили, но замера ещё нет. */
  pending: number;
  /** YYYY-MM-DD — с этого дня считается замер (после окна «после»). */
  measureFrom: string;
}

export interface TrainingEvent {
  id: number;
  title: string;
  description: string;
  /** ISO datetime */
  startsAt: string;
  durationMin: number;
  place: string | null;
  /** null — без лимита */
  capacity: number | null;
  trainer: TaskerPerson | null;
  /** ISO datetime — событие отменено (DELETE). */
  cancelledAt: string | null;
  enrolledCount: number;
  /**
   * Записанные: тренер/админ видит всех; остальные — только менеджеров своего среза
   * (чужих — числом в enrolledCount).
   */
  attendees: TrainingAttendee[];
  /** Показатели, на которые нацелено обучение (tasker_metrics). */
  metricIds: string[];
  /** Окно замера «до/после», дней (по умолчанию 7/7). */
  measureBeforeDays: number;
  measureAfterDays: number;
  /** Слот сетки, из которого собрано занятие (281). */
  slotId: number | null;
  /** Подпись отдела в сетке («Москва», «Руденко»). */
  departmentLabel: string | null;
  effect: TrainingEffectSummary;
  /** Событие в календаре тренера в Битриксе (фаза 1b). failed — «не синхронизировано», будет повтор. */
  calendar: {
    state: 'pending' | 'synced' | 'failed';
    /** Текст ошибки — только тренеру. */
    error: string | null;
    eventId: number | null;
  };
}

/** GET /api/tasker/trainings?from&to&upcoming=1&includeCancelled=1 */
export interface TrainingsResponse {
  events: TrainingEvent[];
  /** Право action.tasker.trainings.manage — создавать/править/отменять. */
  canManage: boolean;
  /** Может записывать менеджеров (action.tasker.assign или тренер). */
  canEnroll: boolean;
  /** Белый список показателей Задачника — подписи и формат для метрик событий/целей/замеров. */
  metrics: TaskerMetric[];
}

/** POST /api/tasker/trainings, PATCH /api/tasker/trainings/:id (все поля опциональны) */
export interface TrainingEventInput {
  title: string;
  description?: string;
  /** ISO datetime */
  startsAt: string;
  durationMin: number;
  place?: string | null;
  capacity?: number | null;
  /** Bitrix id тренера; по умолчанию — создатель. */
  trainerId?: number | null;
  metricIds?: string[];
  /** 7..90, по умолчанию 7. */
  measureBeforeDays?: number;
  measureAfterDays?: number;
  slotId?: number | null;
  departmentLabel?: string | null;
}

export interface TrainingEventResponse {
  event: TrainingEvent;
}

/** POST/DELETE /api/tasker/trainings/:id/enroll */
export interface TrainingEnrollRequest {
  managerId: number;
  /** Запись из формы задачи (сессия C). */
  taskerTaskId?: number | null;
  /** Цель: показатели (по умолчанию — показатели события) и «зачем отправили». */
  goalMetricIds?: string[];
  goalNote?: string | null;
}

/** POST /api/tasker/trainings/:id/attendance — только тренер, после начала события. */
export interface TrainingAttendanceRequest {
  managerId: number;
  /** null — снять отметку. */
  attended: boolean | null;
}

// ── Эффективность ───────────────────────────────────────────────────────────

/** Строка свода: тренер / тема / показатель. Доли и приросты — по посетившим с замером. */
export interface TrainingEffectRow {
  key: string;
  label: string;
  events: number;
  /** Посетили (attended = true). */
  people: number;
  /** С итогом замера (кроме «ещё ждут»). */
  measured: number;
  improved: number;
  noChange: number;
  notEnoughData: number;
  /** improved / (measured − notEnoughData); null — не из чего считать. */
  improvedShare: number | null;
}

export interface TrainingEffectMetricRow extends TrainingEffectRow {
  format: TaskerMetric['format'];
  higherIsBetter: boolean;
  /** Средний прирост менеджеров (после − до) и отдела за те же окна — по замерам с данными. */
  avgDelta: number | null;
  avgDeptDelta: number | null;
}

/** GET /api/tasker/trainings/effectiveness?from&to (по дате события) */
export interface TrainingEffectivenessResponse {
  from: string;
  to: string;
  byTrainer: TrainingEffectRow[];
  byTopic: TrainingEffectRow[];
  byMetric: TrainingEffectMetricRow[];
  metrics: TaskerMetric[];
}

// ── История менеджера ───────────────────────────────────────────────────────

export interface TrainingLogEntry {
  action: 'enroll' | 'unenroll' | 'goal' | 'attended' | 'absent' | 'attendance_cleared' | 'enroll_failed';
  at: string;
  actorName: string | null;
  details: Record<string, unknown>;
}

export interface TrainingHistoryItem {
  event: {
    id: number; title: string; startsAt: string; durationMin: number;
    trainer: TaskerPerson | null; cancelledAt: string | null;
  };
  /** Сейчас записан (false — отписали; видно по журналу). */
  enrolled: boolean;
  enrolledBy: string | null;
  goalMetricIds: string[];
  goalNote: string | null;
  taskerTaskId: number | null;
  attended: boolean | null;
  results: TrainingResult[];
  outcome: TrainingOutcome | null;
  log: TrainingLogEntry[];
}

/** GET /api/tasker/trainings/history?managerId */
export interface TrainingHistoryResponse {
  manager: TaskerPerson;
  items: TrainingHistoryItem[];
  metrics: TaskerMetric[];
}

/** GET /api/tasker/trainings/enrollments?managerIds=1,2&from&to */
export interface TrainingEnrollmentsResponse {
  enrollments: TrainingEnrollment[];
}

/** GET /api/tasker/trainings/managers — кого текущий пользователь может записать. */
export interface TrainingManagerOption {
  id: number;
  name: string;
  departmentName: string | null;
}
export interface TrainingManagersResponse {
  managers: TrainingManagerOption[];
}

// ── Сетка тренера и очередь «Теория» (миграция 281) ─────────────────────────

/** Недельный слот тренера: день × время (Мск). */
export interface TrainingSlot {
  id: number;
  /** null — тренер по умолчанию. */
  trainerId: number | null;
  /** 1 = Пн … 7 = Вс */
  weekday: number;
  /** ЧЧ:ММ по Москве */
  startTime: string;
  durationMin: number;
  /** «Нулевой цикл» */
  label: string | null;
  place: string | null;
  isOffline: boolean;
  /** Закреплённые отделы (uuid). Пусто + есть departmentLabel — закреплён, но отделы не выбраны: автоматически не предлагается. */
  departmentIds: string[];
  departmentLabel: string | null;
  active: boolean;
}
export type TrainingSlotInput = Omit<TrainingSlot, 'id' | 'trainerId'> & { id: number | null };

export interface TrainingGroupSettings {
  /** С какого числа человек по теме система предлагает занятие. */
  min: number;
  /** Сколько обычно берём в группу. */
  target: number;
  /** Больше нельзя. */
  max: number;
  /** На сколько дней вперёд искать свободный слот. */
  horizonDays: number;
}

/** GET/PUT /api/tasker/trainings/slots */
export interface TrainingSlotsResponse {
  slots: TrainingSlot[];
  group: TrainingGroupSettings;
  trainer: TaskerPerson;
  canManage: boolean;
  /** Отделы продаж для закрепления — только тренеру. */
  departments: { id: string; name: string; path: string | null }[];
}
export interface TrainingSlotsSaveRequest {
  slots: TrainingSlotInput[];
  group?: TrainingGroupSettings;
}

/** Открытая задача «Теория» на тренера — карточка очереди. */
export interface TrainingQueueItem {
  taskId: number;
  bitrixTaskId: number | null;
  title: string;
  body: string;
  manager: TaskerPerson;
  departmentName: string | null;
  /** Кто поставил (РОП/директор). */
  creatorName: string | null;
  ropName: string | null;
  metricId: string;
  snapshot: Snapshot | null;
  /** ISO */
  createdAt: string;
  /** ISO */
  deadline: string;
  /** Уже назначено на занятие (ещё не прошедшее). */
  event: { id: number; title: string; startsAt: string } | null;
}

/** Предложенный слот под группу. */
export interface TrainingSuggestion {
  /** ISO */
  startsAt: string;
  durationMin: number;
  slotId: number;
  slotLabel: string | null;
  place: string | null;
  departmentLabel: string | null;
  /** Кого берём (taskId) — первые по давности, до target. */
  taskIds: number[];
  /** Заняты в это время (кроме тренера — он свободен всегда, иначе слот не предлагается). */
  busy: { managerId: number; name: string; title: string }[];
  bitrixChecked: boolean;
}

/** Группа очереди — по показателю (теме). */
export interface TrainingQueueGroup {
  metricId: string;
  label: string;
  items: TrainingQueueItem[];
  /** Сколько ждут (без уже назначенных). */
  waiting: number;
}

/** GET /api/tasker/trainings/queue */
export interface TrainingQueueResponse {
  groups: TrainingQueueGroup[];
  group: TrainingGroupSettings;
  trainer: TaskerPerson;
  canManage: boolean;
  metrics: TaskerMetric[];
  /** false — модель «Теория» в ядре ещё не развёрнута (нет колонки типа задачи). */
  available: boolean;
}

/** POST /api/tasker/trainings/queue/suggest */
export interface TrainingSuggestRequest {
  metricId: string;
  /** Выбранные тренером задачи; пусто — первые по давности до target. */
  taskIds?: number[];
  /** Сколько вариантов вернуть (1–6). */
  limit?: number;
}
export interface TrainingSuggestResponse {
  suggestions: TrainingSuggestion[];
}

/** POST /api/tasker/trainings/queue/assemble — «Собрать занятие». */
export interface TrainingAssembleRequest {
  taskIds: number[];
  startsAt: string;
  durationMin: number;
  title: string;
  description?: string;
  place?: string | null;
  slotId?: number | null;
  departmentLabel?: string | null;
  /** Показатели события; по умолчанию — показатели задач. */
  metricIds?: string[];
}
export interface TrainingAssembleResponse {
  event: TrainingEvent;
  /** Задачи, которые не удалось записать (с причиной). */
  failed: { taskId: number; reason: string }[];
}
