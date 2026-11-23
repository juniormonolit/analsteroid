// Обучения Задачника (сессия D) — типы API /api/tasker/trainings/*.
// Без серверных импортов: тянется и в клиент. TrainingEnrollment (минимальная форма для
// /api/tasker/tasks и видов B) живёт в features/tasker/types.ts — здесь он переиспользуется.
import type { TaskerPerson, TrainingEnrollment } from '../types';

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
}

/** GET /api/tasker/trainings?from&to&upcoming=1&includeCancelled=1 */
export interface TrainingsResponse {
  events: TrainingEvent[];
  /** Право action.tasker.trainings.manage — создавать/править/отменять. */
  canManage: boolean;
  /** Может записывать менеджеров (action.tasker.assign или тренер). */
  canEnroll: boolean;
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
}

export interface TrainingEventResponse {
  event: TrainingEvent;
}

/** POST/DELETE /api/tasker/trainings/:id/enroll */
export interface TrainingEnrollRequest {
  managerId: number;
  /** Запись из формы задачи (сессия C). */
  taskerTaskId?: number | null;
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
