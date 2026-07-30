'use client';
import { useEffect, useRef, useState } from 'react';
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addDays, isSameDay, isBefore, isAfter,
  format, addMonths, subMonths,
  startOfDay, endOfDay,
} from 'date-fns';
import { ru } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DateRange, PresetKey } from '@/lib/period';
import { applyPreset, defaultPeriod, PRESET_LABELS } from '@/lib/period';

// «Этот квартал/год/Всё время» — задача 30.07 (владелец: «добавь в пресеты»).
const PRESETS: PresetKey[] = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'this_year', 'all_time'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Разбор ручного ввода «ДД.ММ.ГГГГ» (задача 30.07, владелец: «сделай так, чтобы
// можно было вводить руками»). Допускаем и «1.7.2026»; строгая проверка через
// обратную сверку компонент (new Date(2026,1,31) молча перескочил бы в март).
function parseRuDate(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = Number(dd), mo = Number(mm), y = Number(yyyy);
  if (y < 2000 || y > 2100) return null;
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

// Мета о происхождении диапазона (задача 10.07: «быстрые кнопки — сравнение
// календарное, ручной диапазон — как раньше, хвост»). presetKey задан только когда
// onChange вызван кликом по кнопке пресета — ручной выбор двух дней в календаре
// вызывает onChange БЕЗ второго аргумента (undefined).
export interface PeriodChangeMeta {
  presetKey: PresetKey;
}

interface Props {
  value: DateRange;
  onChange: (range: DateRange, meta?: PeriodChangeMeta) => void;
  onClose: () => void;
  showPresets?: boolean;
  title?: string;
}

function buildCalendarDays(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const end   = endOfWeek(endOfMonth(month),     { weekStartsOn: 1 });
  const days: Date[] = [];
  let cur = start;
  while (!isAfter(cur, end)) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

export function DateRangePicker({ value, onChange, onClose, showPresets = true, title }: Props) {
  const [month, setMonth] = useState<Date>(() => startOfMonth(value.from));
  // null = waiting for first click; Date = first click done, waiting for second
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [hover, setHover]   = useState<Date | null>(null);

  const today = startOfDay(new Date());
  const days  = buildCalendarDays(month);

  // ── Ручной ввод дат (задача 30.07) ────────────────────────────────────────
  // Черновики строк отделены от value; Enter применяет (при валидной паре),
  // blur применяет только если фокус ушёл ЗА ПРЕДЕЛЫ пикера (relatedTarget вне
  // rootRef) — иначе blur от клика по дню календаря применял бы черновик и
  // закрывал popover раньше, чем сработает сам клик (родитель закрывает попап
  // на каждый onChange). Невалидная дата или от>до — красная рамка, не
  // применяется, страница живёт.
  const rootRef = useRef<HTMLDivElement>(null);
  const [fromStr, setFromStr] = useState(() => format(value.from, 'dd.MM.yyyy'));
  const [toStr, setToStr]     = useState(() => format(value.to, 'dd.MM.yyyy'));
  useEffect(() => {
    setFromStr(format(value.from, 'dd.MM.yyyy'));
    setToStr(format(value.to, 'dd.MM.yyyy'));
  }, [value.from, value.to]);
  const draftFrom = parseRuDate(fromStr);
  const draftTo   = parseRuDate(toStr);
  const inputInvalid =
    draftFrom === null || draftTo === null || isAfter(startOfDay(draftFrom), startOfDay(draftTo));

  function commitManualInput() {
    if (inputInvalid || draftFrom === null || draftTo === null) return;
    const next = { from: startOfDay(draftFrom), to: endOfDay(draftTo) };
    if (isSameDay(next.from, value.from) && isSameDay(next.to, value.to)) return; // ничего не поменялось
    setAnchor(null);
    setHover(null);
    onChange(next); // без meta — семантика ручного выбора (сравнение хвостом)
  }

  function handleInputBlur(e: React.FocusEvent<HTMLInputElement>) {
    // фокус остался внутри пикера (второй инпут, календарь, пресеты) — не применяем
    if (e.relatedTarget && rootRef.current?.contains(e.relatedTarget as Node)) return;
    commitManualInput();
  }

  // Preview range while selecting second date
  const previewFrom = anchor ? (
    hover && isBefore(hover, anchor) ? hover : anchor
  ) : value.from;
  const previewTo = anchor ? (
    hover ? (isBefore(hover, anchor) ? anchor : hover) : anchor
  ) : value.to;

  function inRange(d: Date) {
    return !isBefore(d, previewFrom) && !isAfter(d, previewTo);
  }
  function isStart(d: Date) { return isSameDay(d, previewFrom); }
  function isEnd(d: Date)   { return isSameDay(d, previewTo);   }

  function handleDayClick(d: Date) {
    if (!anchor) {
      setAnchor(d);
    } else {
      const from = isBefore(d, anchor) ? startOfDay(d)      : startOfDay(anchor);
      const to   = isBefore(d, anchor) ? endOfDay(anchor)   : endOfDay(d);
      onChange({ from, to });
      setAnchor(null);
      setHover(null);
      onClose();
    }
  }

  function handlePreset(key: PresetKey) {
    onChange(applyPreset(key), { presetKey: key });
    setAnchor(null);
    onClose();
  }

  // Задача 1593: «По умолчанию» — воспроизводит РОВНО тот диапазон, что видит
  // пользователь при первой загрузке любого отчёта (defaultPeriod() — с 1-го числа
  // текущего месяца по вчера, либо, 1-го числа, весь прошлый месяц — см. lib/period,
  // формула не дублируется). НЕ входит в PresetKey/calendarComparisonForPreset —
  // meta.presetKey сознательно не передаётся, поэтому PeriodRangeControls.
  // handlePeriodChange берёт ветку `manualComparisonFn(p)` (хвост той же длины,
  // см. FilterBar.tsx), а не календарный шаг назад из недавнего коммита (задача
  // 10.07 про «прошлый месяц» и другие быстрые пресеты — та семантика не трогается).
  function handleDefaultPreset() {
    onChange(defaultPeriod());
    setAnchor(null);
    onClose();
  }

  const isCurrentMonth = (d: Date) =>
    d.getMonth() === month.getMonth() && d.getFullYear() === month.getFullYear();

  return (
    // Рамку/тень даёт Popover-обёртка. На телефоне пресеты уходят под календарь.
    <div ref={rootRef} className="flex flex-col sm:flex-row overflow-hidden">

      {/* Calendar */}
      <div className="p-4 w-[300px] max-w-full">
        {title && (
          <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">{title}</p>
        )}

        {/* Ручной ввод дат (задача 30.07): ДД.ММ.ГГГГ, Enter/уход из пикера
            применяет, невалидное — красная рамка без применения. */}
        <div className="flex items-center gap-1.5 mb-3">
          <input
            value={fromStr}
            onChange={e => setFromStr(e.target.value)}
            onBlur={handleInputBlur}
            onKeyDown={e => { if (e.key === 'Enter') commitManualInput(); }}
            placeholder="ДД.ММ.ГГГГ"
            inputMode="numeric"
            aria-label="Дата начала"
            aria-invalid={inputInvalid || undefined}
            className={`flex-1 min-w-0 px-2 py-1 text-sm tabular-nums text-center rounded-lg border bg-[var(--color-bg-surface)] text-[var(--color-text)] outline-none transition-colors ${
              inputInvalid ? 'border-[var(--color-negative)]' : 'border-[var(--color-border)] focus:border-[var(--color-accent)]'
            }`}
          />
          <span className="text-[var(--color-text-muted)] text-sm shrink-0">—</span>
          <input
            value={toStr}
            onChange={e => setToStr(e.target.value)}
            onBlur={handleInputBlur}
            onKeyDown={e => { if (e.key === 'Enter') commitManualInput(); }}
            placeholder="ДД.ММ.ГГГГ"
            inputMode="numeric"
            aria-label="Дата конца"
            aria-invalid={inputInvalid || undefined}
            className={`flex-1 min-w-0 px-2 py-1 text-sm tabular-nums text-center rounded-lg border bg-[var(--color-bg-surface)] text-[var(--color-text)] outline-none transition-colors ${
              inputInvalid ? 'border-[var(--color-negative)]' : 'border-[var(--color-border)] focus:border-[var(--color-accent)]'
            }`}
          />
        </div>

        {/* Month navigation */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setMonth(m => subMonths(m, 1))}
            className="p-1 rounded hover:bg-[var(--color-border)] text-[var(--color-text-muted)] transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-semibold text-[var(--color-text)] capitalize">
            {format(month, 'LLLL yyyy', { locale: ru })}
          </span>
          <button
            onClick={() => setMonth(m => addMonths(m, 1))}
            className="p-1 rounded hover:bg-[var(--color-border)] text-[var(--color-text-muted)] transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-1">
          {WEEKDAYS.map(w => (
            <div key={w} className="text-center text-xs text-[var(--color-text-muted)] py-1 font-medium">
              {w}
            </div>
          ))}
        </div>

        {/* Days grid */}
        <div className="grid grid-cols-7 gap-y-0.5"
          onMouseLeave={() => setHover(null)}
        >
          {days.map((d, i) => {
            const inCur  = isCurrentMonth(d);
            const start  = isStart(d);
            const end    = isEnd(d);
            const mid    = inRange(d) && !start && !end;
            const isToday = isSameDay(d, today);

            let cellCls = 'relative flex items-center justify-center h-8 text-sm select-none cursor-pointer transition-colors ';

            // Range background (stretches full width for middle days)
            if (mid) cellCls += 'bg-[var(--color-accent)]/15 ';

            // Start cap
            if (start && !isSameDay(previewFrom, previewTo)) cellCls += 'bg-[var(--color-accent)]/15 rounded-l-full ';
            // End cap
            if (end && !isSameDay(previewFrom, previewTo)) cellCls += 'bg-[var(--color-accent)]/15 rounded-r-full ';
            // Single day (start == end)
            if (start && isSameDay(previewFrom, previewTo)) cellCls += 'rounded-full ';

            let innerCls = 'w-7 h-7 flex items-center justify-center rounded-full text-sm font-medium z-10 ';
            if (start || end) {
              innerCls += 'bg-[var(--color-accent)] text-[var(--color-text-inverse)] ';
            } else if (isToday) {
              innerCls += 'border border-[var(--color-accent)] text-[var(--color-accent)] ';
            } else if (!inCur) {
              innerCls += 'text-[var(--color-text-muted)] ';
            } else {
              innerCls += 'text-[var(--color-text)] hover:bg-[var(--color-border)] ';
            }

            return (
              <div
                key={i}
                className={cellCls}
                onClick={() => handleDayClick(startOfDay(d))}
                onMouseEnter={() => anchor && setHover(startOfDay(d))}
              >
                <span className={innerCls}>
                  {format(d, 'd')}
                </span>
              </div>
            );
          })}
        </div>

        {/* Hint */}
        <p className="mt-2 text-xs text-[var(--color-text-muted)] text-center h-4">
          {anchor ? `Выберите конечную дату` : ''}
        </p>
      </div>

      {/* Presets: на sm+ — вертикальный рейл справа, на телефоне — чипы под календарём */}
      {showPresets && (
        <div className="border-t sm:border-t-0 sm:border-l border-[var(--color-border)] py-3 px-2 sm:w-[168px] flex flex-row flex-wrap sm:flex-col gap-0.5">
          <p className="w-full text-xs font-medium text-[var(--color-text-muted)] px-2 mb-1 uppercase tracking-wide">Пресеты</p>
          <button
            onClick={handleDefaultPreset}
            className="text-left px-2 py-1.5 text-sm rounded hover:bg-[var(--color-border)] text-[var(--color-text)] transition-colors whitespace-nowrap"
          >
            По умолчанию
          </button>
          {PRESETS.map(key => (
            <button
              key={key}
              onClick={() => handlePreset(key)}
              className="text-left px-2 py-1.5 text-sm rounded hover:bg-[var(--color-border)] text-[var(--color-text)] transition-colors whitespace-nowrap"
            >
              {PRESET_LABELS[key]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
