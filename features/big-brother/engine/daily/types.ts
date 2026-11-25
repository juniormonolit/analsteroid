// «Большой брат», поток D — дневной агрегат activity_daily, лента дня и календарь человека (BIG_BROTHER_SPEC.md,
// «Лента и календарь человека»). Типы общие для движка, API и UI (без серверных импортов).

/** Полоса ленты дня. Канбан повторки и канбан логистов — сервисы Монолитики, рисуются в её полосе. */
export type DayBand = 'mono' | 'call' | 'deal' | 'task';
export const DAY_BANDS: readonly DayBand[] = ['mono', 'call', 'deal', 'task'];
export const BAND_LABEL: Record<DayBand, string> = {
  mono: 'Монолитика', call: 'Звонки', deal: 'Сделки', task: 'Задачи',
};

/** Роль человека в мониторинге (по оргструктуре и логину Битрикса). */
export type PersonRole = 'mop' | 'rop' | 'director' | 'logist';
export const ROLE_LABEL: Record<PersonRole, string> = {
  mop: 'МОП', rop: 'РОП', director: 'Директор', logist: 'Логист',
};

/** Одно событие ленты (минутная точность; дубли одного вида в минуте схлопнуты). */
export interface DayEventDto {
  at: string;        // ISO
  band: DayBand;
  kind: string;      // kind таксономии lib/activity/types.ts (call / deal_stage / task / mono_view / kanban …)
  action: string | null;
  /** «Слабый» сигнал: изменение задачи без автора, пропущенный входящий — в ленте есть, «в работе» не делает. */
  weak: boolean;
  n: number;         // сколько событий схлопнуто в эту минуту
}

/** Строка activity_daily, как её отдаёт API. */
export interface DailyRowDto {
  date: string;
  bitrixUserId: string;
  name: string | null;
  departmentId: string | null;
  departmentName: string | null;
  ropBitrixId: string | null;
  isWorkday: boolean | null;
  inWork: boolean;
  monoMinutes: number;
  /** 5-мин отрезков с сильным сигналом из любого источника (интенсивность календаря). */
  buckets: number;
  firstSignalAt: string | null;
  lastSignalAt: string | null;
  counts: Record<string, number>;
  sections: Record<string, number>;
  surfaces: Record<string, number>;
  tasksCreated: number;
  tasksClosed: number;
  tasksOverdue: number;
}

export interface PersonListItem {
  id: string;
  name: string;
  role: PersonRole;
  departmentId: string | null;
  departmentName: string | null;
  ropName: string | null;
  /** Строка за выбранную дату (null — агрегат за дату ещё не собран). */
  day: Pick<DailyRowDto, 'inWork' | 'monoMinutes' | 'buckets' | 'firstSignalAt' | 'lastSignalAt' | 'counts'> | null;
}

export interface PeopleResponse {
  date: string;
  people: PersonListItem[];
  /** Когда собран агрегат за дату (max built_at), null — не собран. */
  builtAt: string | null;
}

export interface PersonDayResponse {
  date: string;
  person: { id: string; name: string; role: PersonRole; departmentName: string | null; ropName: string | null };
  /** Посчитано вживую из источников (не из activity_daily). */
  day: DailyRowDto;
  events: DayEventDto[];
  /** Ось ленты: начало/конец рабочего окна МСК и фактический охват сигналов. */
  windowStartHour: number;
  windowEndHour: number;
  /** Провалы «нет сигнала» внутри рабочего окна (≥ GAP_MIN минут), ISO. */
  gaps: { from: string; to: string }[];
  /** Источники, которые не прочитались (таблицы нет / ошибка) — лента по ним неполная. */
  failedSources: string[];
}

export interface CalendarDayDto {
  date: string;
  isWorkday: boolean | null;
  inWork: boolean;
  buckets: number;
  monoMinutes: number;
  calls: number;
  deals: number;
  tasks: number;
}

export interface PersonCalendarResponse {
  from: string;
  to: string;
  days: CalendarDayDto[];
}

/** Порог «нет сигнала» в ленте, минуты (обед — час, поэтому разрыв короче часа провалом не считаем). */
export const GAP_MIN = 60;
