// «Большой брат» — рейтинг РОПов: контракт API GET /api/big-brother/rop.
import type { BbPeriod } from './period';

export type RopService = 'tasker' | 'big' | 'repeat';
export const ROP_SERVICES: readonly RopService[] = ['tasker', 'big', 'repeat'];
export const SERVICE_LABEL: Record<RopService, string> = { tasker: 'Задачник', big: 'Большие чеки', repeat: 'Повторка' };

/** Одна задача, поставленная РОПом за период (после склейки источников). */
export interface RopTask {
  key: string;
  service: RopService;
  /** mono — через Монолитику (Задачник / канбан повторки); direct — руками в Битриксе в группе сервиса. */
  via: 'mono' | 'direct';
  creatorId: string;
  /** Кому задача (менеджер-адресат; у Задачника — manager_bitrix_id, не исполнитель-РОП). */
  assigneeId: string | null;
  createdAt: string;
  bitrixTaskId: number | null;
  /** Текущий статус задачи в Битриксе (1–7), null — не нашли в копии. */
  status: number | null;
  closedAt: string | null;
  closedBy: string | null;
  deadlineAt: string | null;
  /** Задачник: вердикт автозамера. */
  verdict: string | null;
}

export interface ServiceCounts { tasker: number; big: number; repeat: number }

export interface RopFollowThrough {
  /** Закрыты (статус 5). */
  closed: number;
  /** Ждут контроля РОПа (статус 4). */
  waitingControl: number;
  /** Закрыты самим РОПом (closed_by = постановщик) + приёмки в канбане повторки. */
  accepted: number;
  /** Открыты и просрочены сейчас. */
  overdueOpen: number;
  /** Возвращены на доработку из канбана повторки. */
  returned: number;
  /** Задачник: задач с замером по показателю (achieved / improved / no_change). */
  taskerMeasured: number;
  /** Задачник: из них показатель вырос (achieved / improved). */
  taskerImproved: number;
}

export interface DeptMetrics {
  /** Продажи (перв. + повт.), ₽. */
  salesAmount: number;
  /** План продаж на период, ₽ (null — плана нет ни у кого из команды). */
  planAmount: number | null;
  /** Выполнение плана, доля 0..∞. */
  planPct: number | null;
  /** CR Сделка → Продажа (все), доля. */
  cr: number | null;
  /** Средний чек (все продажи), ₽. */
  avgCheck: number | null;
  salesCount: number;
  dealsCount: number;
}

export interface RopSubordinate {
  id: string;
  name: string;
  deptName: string | null;
  tasks: number;
  byService: ServiceCounts;
  closed: number;
  overdueOpen: number;
  lastTaskAt: string | null;
  metrics: DeptMetrics | null;
}

export interface RopRow {
  id: string;
  name: string;
  deptNames: string[];
  branch: string | null;
  subordinates: number;
  tasks: number;
  tasksPerSub: number | null;
  byService: ServiceCounts;
  mono: number;
  direct: number;
  /** Дней с постановкой задач / рабочих дней периода. */
  activeDays: number;
  workdays: number;
  /** Рабочих недель периода без единой задачи. */
  gapWeeks: number;
  weeks: number;
  /** Задач по неделям периода (ключ — понедельник). */
  weekly: number[];
  /** Охват: подчинённых, получивших хоть одну задачу. */
  covered: number;
  coverage: number | null;
  follow: RopFollowThrough;
  /** Доля задач Задачника «показатель вырос» среди замеренных. */
  taskerImprovedPct: number | null;
  dept: DeptMetrics | null;
  subs: RopSubordinate[];
}

export interface RopRatingResponse {
  period: BbPeriod;
  weekStarts: string[];
  generatedAt: string;
  rows: RopRow[];
  /** Что не посчитано и почему — показываем под таблицей. */
  notes: string[];
}
