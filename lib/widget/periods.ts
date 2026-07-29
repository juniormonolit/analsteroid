import {
  startOfWeek, startOfQuarter, addDays,
} from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import type { DateRange } from '@/lib/period';

// Пять фиксированных пресетов конструктора виджетов — «текущий X к сегодня».
// Своя маленькая таблица периодов, а НЕ расширение lib/period::PresetKey: тот тип
// завязан на исчерпывающие switch/Record по всему UI отчётов (PRESET_UNIT,
// presetAnchorDate, PRESET_LABELS) — добавлять туда quarter/year инвазивно и рискованно.

const TZ = 'Europe/Moscow';

export type WidgetPeriodPreset = 'today' | 'this_week' | 'this_month' | 'this_quarter' | 'this_year';

export const WIDGET_PERIOD_PRESETS: WidgetPeriodPreset[] = [
  'today', 'this_week', 'this_month', 'this_quarter', 'this_year',
];

export const WIDGET_PERIOD_LABELS: Record<WidgetPeriodPreset, string> = {
  today: 'Сегодня',
  this_week: 'Эта неделя',
  this_month: 'Этот месяц',
  this_quarter: 'Этот квартал',
  this_year: 'Этот год',
};

/** Начало периода (YYYY-MM-DD) для пресета относительно `todayStr` (МСК-дата).
 *  Всё считаем UTC-арифметикой на UTC-полуночи todayStr — календарные даты точны,
 *  без сдвига пояса (нужны только даты, не инстанты). */
function periodFromStr(preset: WidgetPeriodPreset, todayStr: string): string {
  if (preset === 'today') return todayStr;
  if (preset === 'this_month') return `${todayStr.slice(0, 7)}-01`;
  if (preset === 'this_year') return `${todayStr.slice(0, 4)}-01-01`;
  const utcMidnight = new Date(`${todayStr}T00:00:00.000Z`);
  if (preset === 'this_week') {
    // ISO-неделя (Пн). startOfWeek читает локальные геттеры, но на UTC-полуночи
    // локальная и UTC-дата совпадают только в UTC-хосте — поэтому считаем смещение
    // до понедельника вручную по getUTCDay (0=Вс..6=Сб).
    const dow = utcMidnight.getUTCDay();
    const backToMonday = (dow + 6) % 7;
    return addDays(utcMidnight, -backToMonday).toISOString().slice(0, 10);
  }
  // this_quarter
  const q = startOfQuarter(utcMidnight);
  const y = q.getUTCFullYear();
  const m = String(q.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export interface ResolvedWidgetPeriod {
  range: DateRange;   // инстанты для fetchByManagers (SQL-границы по timestamptz)
  fromStr: string;    // YYYY-MM-DD начала периода (для плана)
  todayStr: string;   // YYYY-MM-DD «сегодня» МСК (правая граница/кап плана)
}

export function resolveWidgetPeriod(preset: WidgetPeriodPreset): ResolvedWidgetPeriod {
  const todayStr = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
  const fromStr = periodFromStr(preset, todayStr);
  return {
    range: {
      from: new Date(`${fromStr}T00:00:00.000Z`),
      to: new Date(`${todayStr}T23:59:59.999Z`),
    },
    fromStr,
    todayStr,
  };
}
