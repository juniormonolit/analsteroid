'use client';

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DashCompare, DashCompareMonth, DashCompareWeek, DashCompareYear, DashPeriodResponse } from '../engine/period';
import {
  MONTHS_GEN, MONTHS_NOM, MONTHS_SHORT, WEEKDAYS_SHORT, YEAR_START_MD, addDays, addMonths, mondayOf, offsetOfDay, periodLabel, periodRange, weekdayIndex,
  type DashPeriod,
} from '../shared';
import { C } from './theme';

// «Дашборд тест» — вкладки «Неделя / Месяц / Год» (набросок владельца 08.10): выбор даты
// и столбчатый график «Сделки по дням» (для года — по месяцам). Сделки здесь — первичные,
// созданные за период (по дате создания), а не продажи; слова «лиды» в системе нет (правка
// владельца 09.10: сначала раздел назывался «лиды»). Сверху — сравнение с
// предыдущим периодом (решение владельца 08.10), у каждого свой способ выравнивания:
//   неделя — столбцы по дням недели рядом; итог — день ко дню (те же дни недели), над
//            каждым днём изменение в процентах к тому же дню прошлой недели;
//   месяц  — пары столбцов по дням; каждый день — против того же дня недели 4 недели назад;
//   год    — сделок в месяц, пары столбцов; итог — по те же даты прошлого года.
// Всё по календарным дням (решение владельца 09.10; сначала месяц и год выравнивались по
// рабочим дням — убрано).
// Все числа сравнения считает сервер (engine/period.ts), здесь только показ.
// Ниже — «Сделки по филиалам» (правка владельца 08.10): филиалы рядом, по каждому итог за
// период, доля и изменение к предыдущему периоду. При выбранном городе та же карточка
// сравнивает его департаменты. Срез (город и/или департамент) задаёт страница набором
// узлов — их серии здесь складываются (withGroups). Город выбирается
// теми же вкладками, что на «Сегодня». Оформление — та же палитра страницы (theme.ts).

const nf = new Intl.NumberFormat('ru-RU');
const card = { background: C.surface, borderRadius: 10 } as const;

export function useDashPeriod(period: DashPeriod | null, offset: number) {
  return useQuery<DashPeriodResponse>({
    queryKey: ['dashboard-test-period', period, offset],
    queryFn: async () => {
      const res = await fetch(`/api/dashboard-test/period?period=${period}&offset=${offset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: period != null,
    refetchInterval: 60_000,
    // пока грузится соседняя неделя/месяц — на экране остаётся прежний график того же вида
    placeholderData: prev => (prev && prev.period === period ? prev : undefined),
  });
}

const PERIOD_WORDS: Record<DashPeriod, { prev: string; next: string; current: string }> = {
  week: { prev: 'Предыдущая неделя', next: 'Следующая неделя', current: 'Текущая неделя' },
  month: { prev: 'Предыдущий месяц', next: 'Следующий месяц', current: 'Текущий месяц' },
  year: { prev: 'Предыдущий год', next: 'Следующий год', current: 'Текущий год' },
};

/** Выбор даты (стоит в полосе периода на странице, справа от вкладок): стрелки на один период, кнопка с датами — по нажатию открывается
 *  календарь (неделя — месяц по неделям, месяц — 12 месяцев года, год — список лет) —
 *  и «Текущая неделя / месяц / год», чтобы вернуться одним нажатием.
 *  Первый вариант был ползунком (как на наброске): владелец счёл его неудобным —
 *  по нему не попасть в нужную неделю. */
export function DatePicker({ period, offset, maxOffset, today, onChange }: {
  period: DashPeriod; offset: number; maxOffset: number; today: string; onChange: (offset: number) => void;
}) {
  const r = periodRange(period, offset, today);
  const words = PERIOD_WORDS[period];
  const [open, setOpen] = useState(false);
  // что листаем в календаре: для недели — месяц «ГГГГ-ММ», для месяца — год (его же первые 4 знака)
  const [view, setView] = useState(r.from.slice(0, 7));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const allowed = (o: number) => o >= 0 && o <= maxOffset;
  const pick = (o: number) => { if (allowed(o)) onChange(o); setOpen(false); };
  const toggle = () => { if (!open) setView(r.from.slice(0, 7)); setOpen(!open); };
  // кнопка с датами умеет сжиматься (длинная дата на телефоне), остальные — нет
  const btnBase = 'dt-click inline-flex h-9 items-center justify-center rounded-lg disabled:cursor-default disabled:opacity-35 disabled:shadow-none';
  const btn = `${btnBase} shrink-0`;
  const navBtn = `${btn} w-9`;

  return (
    <div ref={ref} className="relative flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" className={navBtn} style={{ color: C.primary }} onClick={() => pick(offset + 1)} disabled={!allowed(offset + 1)} aria-label={words.prev} title={words.prev}><ChevronLeft size={18} /></button>
        <button type="button" className={`${btnBase} min-w-0 gap-2 px-3 text-[14px] font-bold tabular-nums`} style={{ background: C.mutedBg, color: C.text }}
          onClick={toggle} aria-haspopup="dialog" aria-expanded={open} title="Открыть календарь">
          <CalendarDays size={16} className="shrink-0" style={{ color: C.primary }} />
          <span className="min-w-0 truncate">{periodLabel(period, r.from, r.to)}</span>
          <ChevronDown size={15} className="shrink-0" style={{ color: C.muted }} />
        </button>
        <button type="button" className={navBtn} style={{ color: C.primary }} onClick={() => pick(offset - 1)} disabled={!allowed(offset - 1)} aria-label={words.next} title={words.next}><ChevronRight size={18} /></button>
      </div>
      {offset > 0 && (
        <button type="button" className={`${btn} px-3 text-[13px] font-bold`} style={{ color: C.primary }} onClick={() => pick(0)}>{words.current}</button>
      )}

      {open && (
        <div role="dialog" aria-label="Выбор даты" className="absolute left-0 top-full z-30 mt-3 w-[308px] max-w-[calc(100vw-48px)] rounded-[12px] p-3 lg:left-auto lg:right-0"
          style={{ background: C.surface, border: `1px solid ${C.line}`, boxShadow: '0 16px 40px rgba(0,0,0,0.22)' }}>
          {period === 'week' && <WeekGrid view={view} setView={setView} selectedFrom={r.from} today={today} allowed={allowed} onPick={pick} navBtn={navBtn} />}
          {period === 'month' && <MonthGrid year={Number(view.slice(0, 4))} setView={setView} selected={r.from.slice(0, 7)} today={today} allowed={allowed} onPick={pick} navBtn={navBtn} />}
          {period === 'year' && (
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: maxOffset + 1 }, (_, i) => maxOffset - i).map(o => {
                const y = Number(today.slice(0, 4)) - o;
                return (
                  <button key={y} type="button" onClick={() => pick(o)} className="dt-click h-10 rounded-lg text-[14px] font-bold tabular-nums"
                    style={o === offset ? { background: C.primary, color: C.onPrimary } : { background: C.mutedBg, color: C.text }}>{y}</button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type GridProps = { today: string; allowed: (o: number) => boolean; onPick: (o: number) => void; navBtn: string; setView: (v: string) => void };

function GridHead({ title, onPrev, onNext, navBtn }: { title: string; onPrev: () => void; onNext: () => void; navBtn: string }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <button type="button" className={navBtn} style={{ color: C.primary }} onClick={onPrev} aria-label="Назад"><ChevronLeft size={18} /></button>
      <div className="text-[14px] font-bold">{title}</div>
      <button type="button" className={navBtn} style={{ color: C.primary }} onClick={onNext} aria-label="Вперёд"><ChevronRight size={18} /></button>
    </div>
  );
}

/** Календарь месяца, где выбирается целая неделя: строка — неделя с понедельника. */
function WeekGrid({ view, setView, selectedFrom, today, allowed, onPick, navBtn }: GridProps & { view: string; selectedFrom: string }) {
  const first = `${view}-01`;
  const weeks: string[] = [];
  for (let m = mondayOf(first); m.slice(0, 7) <= view && weeks.length < 6; m = addDays(m, 7)) weeks.push(m);
  return (
    <>
      <GridHead title={`${MONTHS_NOM[Number(view.slice(5, 7)) - 1]} ${view.slice(0, 4)}`} onPrev={() => setView(addMonths(view, -1))} onNext={() => setView(addMonths(view, 1))} navBtn={navBtn} />
      <div className="grid grid-cols-7 px-1 pb-1 text-center text-[11px] font-bold uppercase" style={{ color: C.muted }}>
        {WEEKDAYS_SHORT.map(d => <span key={d}>{d}</span>)}
      </div>
      <div className="flex flex-col gap-1">
        {weeks.map(monday => {
          const o = offsetOfDay('week', monday, today);
          const ok = allowed(o);
          const selected = monday === selectedFrom;
          return (
            <button key={monday} type="button" disabled={!ok} onClick={() => onPick(o)} aria-label={`Неделя с ${Number(monday.slice(8, 10))} ${MONTHS_SHORT[Number(monday.slice(5, 7)) - 1]}.`}
              className="dt-click grid h-9 grid-cols-7 items-center rounded-lg px-1 text-center text-[13px] font-medium tabular-nums disabled:cursor-default disabled:opacity-35 disabled:shadow-none"
              style={selected ? { background: C.primary, color: C.onPrimary } : { background: C.mutedBg, color: C.text }}>
              {Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map(d => (
                <span key={d} className={d === today ? 'font-bold underline underline-offset-2' : undefined} style={{ opacity: d.slice(0, 7) === view ? 1 : 0.45 }}>{Number(d.slice(8, 10))}</span>
              ))}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Двенадцать месяцев года. */
function MonthGrid({ year, setView, selected, today, allowed, onPick, navBtn }: GridProps & { year: number; selected: string }) {
  return (
    <>
      <GridHead title={String(year)} onPrev={() => setView(`${year - 1}-01`)} onNext={() => setView(`${year + 1}-01`)} navBtn={navBtn} />
      <div className="grid grid-cols-3 gap-1.5">
        {MONTHS_NOM.map((name, i) => {
          const ym = `${year}-${String(i + 1).padStart(2, '0')}`;
          const o = offsetOfDay('month', `${ym}-01`, today);
          return (
            <button key={ym} type="button" disabled={!allowed(o)} onClick={() => onPick(o)}
              className="dt-click h-10 rounded-lg text-[13px] font-bold disabled:cursor-default disabled:opacity-35 disabled:shadow-none"
              style={ym === selected ? { background: C.primary, color: C.onPrimary } : { background: C.mutedBg, color: C.text }}>{name}</button>
          );
        })}
      </div>
    </>
  );
}

/** Верх шкалы и шаг делений: «круглые» числа с запасом под подпись над самым высоким столбцом. */
function niceScale(max: number): { top: number; step: number } {
  const target = Math.max(1, max) * 1.12;
  const raw = target / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, [1, 2, 5, 10].map(k => k * pow).find(s => s >= raw) ?? 10 * pow);
  return { top: Math.ceil(target / step) * step, step };
}

interface Bar { key: string; label: string; sub: string | null; future: boolean; current: boolean; title: string }

function barsOf(resp: DashPeriodResponse): Bar[] {
  return resp.buckets.map(key => {
    if (resp.period === 'year') {
      const m = Number(key.slice(5, 7));
      const cur = resp.today.slice(0, 7);
      return { key, label: MONTHS_SHORT[m - 1], sub: null, future: key > cur, current: key === cur, title: `${MONTHS_SHORT[m - 1]} ${key.slice(0, 4)}` };
    }
    const d = Number(key.slice(8, 10)), m = Number(key.slice(5, 7));
    const wd = WEEKDAYS_SHORT[weekdayIndex(key)];
    return {
      key, sub: resp.period === 'week' ? wd : null,
      label: resp.period === 'week' ? `${d} ${MONTHS_SHORT[m - 1]}.` : String(d),
      future: key > resp.today, current: key === resp.today, title: `${d} ${MONTHS_SHORT[m - 1]}., ${wd}`,
    };
  });
}

const CHART_H = 340;

function CreatedChart({ resp, values }: { resp: DashPeriodResponse; values: number[] }) {
  const bars = barsOf(resp);
  const dense = bars.length > 14;
  const { top, step } = niceScale(Math.max(0, ...values));
  const ticks: number[] = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);
  const pct = (v: number) => `${(v / top) * 100}%`;
  // ширина шкалы — по самой длинной подписи («20 000» шире, чем «600»)
  const AXIS_W = Math.max(40, nf.format(top).length * 8 + 16);
  // на узком экране график не сжимается в кашу, а прокручивается вбок
  const minWidth = AXIS_W + bars.length * (dense ? 18 : resp.period === 'year' ? 46 : 38);
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth }}>
        <div className="mb-1 text-[12px] font-medium" style={{ color: C.muted }}>Сделки, шт.</div>
        <div className="flex">
          <div className="relative shrink-0" style={{ width: AXIS_W, height: CHART_H }}>
            {ticks.map(t => (
              <span key={t} className="absolute right-2 text-[12px] tabular-nums" style={{ bottom: pct(t), transform: 'translateY(50%)', color: C.muted }}>{nf.format(t)}</span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1" style={{ height: CHART_H }}>
            {ticks.map(t => <div key={t} className="absolute inset-x-0" style={{ bottom: pct(t), borderTop: `1px solid ${t === 0 ? C.line : C.track}` }} />)}
            <div className="absolute inset-0 flex items-end">
              {bars.map((b, i) => (
                <div key={b.key} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={b.future ? b.title : `${b.title}: ${nf.format(values[i])}`}>
                  {!b.future && (
                    <>
                      <span className="mb-1 whitespace-nowrap font-bold leading-none tabular-nums" style={dense ? { fontSize: 10, writingMode: 'vertical-rl', transform: 'rotate(180deg)' } : { fontSize: 14 }}>{nf.format(values[i])}</span>
                      <div className="w-[62%] max-w-[110px] rounded-t-[3px]" style={{ height: pct(values[i]), minHeight: values[i] > 0 ? 2 : 0, background: C.primary, opacity: b.current ? 0.5 : 1 }} />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex" style={{ paddingLeft: AXIS_W }}>
          {bars.map(b => (
            <div key={b.key} className="min-w-0 flex-1 pt-2 text-center leading-tight" style={{ opacity: b.future ? 0.5 : 1 }}>
              <div className="whitespace-nowrap font-medium" style={{ fontSize: dense ? 12 : 13 }}>{b.label}</div>
              {b.sub && <div className="text-[11px]" style={{ color: C.muted }}>{b.sub}</div>}
            </div>
          ))}
        </div>
        <div className="mt-2 text-center text-[13px] font-medium" style={{ paddingLeft: AXIS_W, color: C.muted }}>{resp.period === 'year' ? 'Месяц' : 'День'}</div>
      </div>
    </div>
  );
}

// ───────────────────────── сравнение с предыдущим периодом ─────────────────────────

const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const signed = (v: number, text: string) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${text}`;

/** «5–8 окт», «28 сен – 4 окт», через год — с годами. */
export function shortRange(from: string, to: string): string {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy !== ty) return `${fd} ${MONTHS_SHORT[fm - 1]} ${fy} – ${td} ${MONTHS_SHORT[tm - 1]} ${ty}`;
  if (fm !== tm) return `${fd} ${MONTHS_SHORT[fm - 1]} – ${td} ${MONTHS_SHORT[tm - 1]}`;
  return fd === td ? `${fd} ${MONTHS_SHORT[fm - 1]}` : `${fd}–${td} ${MONTHS_SHORT[fm - 1]}`;
}
const monthName = (day: string) => `${MONTHS_NOM[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
/** Плашка выбранного фильтра в заголовке графика: филиал — синяя, департамент — жёлтая
 *  (те же цвета, что у самих фильтров на странице). */
export interface FilterTag { label: string; tone: 'primary' | 'accent' }

/** Заголовок карточки графика; за названием — что выбрано в фильтрах (правка владельца 09.10:
 *  «во всех названиях подставлять фильтр»), чтобы по одной карточке было видно, чьи это цифры. */
function CardTitle({ children, tags }: { children: ReactNode; tags: FilterTag[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <div className="text-[20px] font-bold leading-tight">{children}</div>
      {tags.map(t => (
        <span key={`${t.tone}${t.label}`} className="rounded-md px-2 py-0.5 text-[13px] font-bold leading-snug"
          style={t.tone === 'accent' ? { background: C.accent, color: C.onAccent } : { background: C.primary, color: C.onPrimary }}>{t.label}</span>
      ))}
    </div>
  );
}

/** Сетка трёх плиток итога. ВЁРСТКА ПОД ШИРИНУ КАРТОЧКИ (владелец 10.10: «чтоб вёрстка менялась
 *  при разных размерах экрана, а не съезжала»): раньше плитки шли «сколько влезет по 230px» и в
 *  карточке шириной ~650px (два графика в ряд на ноутбуке) третья съезжала на вторую строку.
 *  Теперь у карточки три состояния по её собственной ширине (@container/card):
 *    от 760px — три плитки в ряд, крупные цифры (28px);
 *    560–760px — три плитки в ряд, цифры и подписи мельче (22px / 12px);
 *    уже 560px (телефон) — плитки одна под другой. */
const KPI_GRID = 'mt-3 grid grid-cols-1 gap-2 @[560px]/card:grid-cols-3 @[760px]/card:gap-3';

function Kpi({ label, sub, on, children }: { label: string; /** из чего сложилось число — мелкой строкой под ним */ sub?: string | null; /** плитка показывает выбранный на графике день / месяц */ on?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-[10px] px-3 py-2.5 @[760px]/card:px-4 @[760px]/card:py-3" style={{ background: C.mutedBg, boxShadow: on ? `inset 0 0 0 2px ${C.primary}` : undefined }}>
      <div className="text-[12px] font-medium leading-snug @[760px]/card:text-[13px]" style={{ color: C.muted }}>{label}</div>
      <div className="mt-1 text-[22px] font-bold leading-tight tabular-nums @[760px]/card:text-[28px]">{children}</div>
      {sub && <div className="mt-0.5 text-[12px] font-medium leading-snug tabular-nums" style={{ color: C.muted }}>{sub}</div>}
    </div>
  );
}

/** Отклонение текущего от базы: стрелка, процент и разница в штуках (зелёное — рост). */
function Delta({ cur, base, unit }: { cur: number | null; base: number | null; unit?: string }) {
  if (cur == null || base == null || base <= 0) return <span style={{ color: C.muted }}>—</span>;
  const diff = cur - base;
  const pct = (diff / base) * 100;
  const color = diff > 0 ? C.successText : diff < 0 ? C.error : C.text;
  const Icon = diff >= 0 ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2" style={{ color }}>
      <span className="inline-flex items-center gap-1">{diff !== 0 && <Icon className="h-[18px] w-[18px] shrink-0 @[760px]/card:h-[22px] @[760px]/card:w-[22px]" />}{signed(pct, nf1.format(Math.abs(pct)))}%</span>
      <span className="text-[13px] font-medium @[760px]/card:text-[15px]" style={{ color: C.muted }}>({signed(diff, nf.format(Math.abs(Math.round(diff))))}{unit ? ` ${unit}` : ''})</span>
    </span>
  );
}

// ───────────────────────── интерактивность графиков ─────────────────────────
// Правка владельца 09.10: «чтоб все графики были интерактивные… при нажатии делается фильтр на
// то, что нажал, как в Power BI». Первый вариант подсвечивал день и показывал подсказку уже при
// НАВЕДЕНИИ — владельцу не понравилось («не нравится, что при наведении выделяется часть графика;
// при нажатии появляется подсказка, при наведении ничего не происходит»). Теперь всё по НАЖАТИЮ:
//   • нажали на день / месяц — у места нажатия появляется подсказка с его цифрами, день
//     отмечается синей рамкой на всех графиках того же периода, а три числа сверху каждой
//     карточки показывают этот день вместо итога периода;
//   • снять выбор — нажать на тот же день ещё раз, «Снять выбор» или Esc; нажатие мимо графика
//     убирает только подсказку;
//   • нажали на плитку филиала / департамента в «Сделки по филиалам» — включается фильтр
//     страницы по нему.
// При наведении ничего не происходит. scope — «период|первый день»: графики одного периода
// делят выбранный день.
// ЕЩЁ ПРАВКА (владелец 09.10, следом): «при нажатии не надо ничего выделять, а только чтоб
// подсказка появлялась». Поэтому сейчас по нажатию показывается ТОЛЬКО подсказка: рамки вокруг
// дня нет, числа сверху карточек не меняются. Выбор дня (рамка + цифры дня сверху) не удалён, а
// выключен флагом ниже — если владелец захочет его вернуть, достаточно поставить true.
const PIN_ON_CLICK = false;
interface FxAt { scope: string; i: number }
interface Fx {
  pin: FxAt | null;
  /** Нажали на столбец: выбрать его и показать подсказку у места нажатия (на выбранном — снять выбор). */
  click: (scope: string, i: number, tip: () => ReactNode, e: ReactMouseEvent) => void;
  clear: () => void;
}
const FxCtx = createContext<Fx>({ pin: null, click: () => {}, clear: () => {} });

/** Выбор столбцов одного графика. active — выбранный столбец (или null). */
function useFx(scope: string) {
  const fx = useContext(FxCtx);
  const pin = PIN_ON_CLICK && fx.pin?.scope === scope ? fx.pin.i : null;
  return {
    active: pin, pin,
    /** Обработчик столбца i; tip — содержимое подсказки. */
    col: (i: number, tip: () => ReactNode) => ({
      'data-fx-col': '',
      onClick: (e: ReactMouseEvent) => fx.click(scope, i, tip, e),
    }),
    /** Вид столбца: выбранный — в синей рамке на светлой полосе. */
    look: (i: number): CSSProperties => ({
      cursor: 'pointer', borderRadius: 6,
      background: pin === i ? C.mutedBg : undefined,
      boxShadow: pin === i ? `inset 0 0 0 2px ${C.primary}` : undefined,
    }),
    unpin: fx.clear,
  };
}

/** Содержимое подсказки: что за показатель, строки «цвет — что — значение», изменение, что будет по нажатию. */
function TipBox({ title, rows, delta, hint }: {
  title: string;
  rows: ({ color: string; label: string; value: string; sub?: string | null } | null)[];
  delta?: { text: string; color: string } | null;
  hint?: string;
}) {
  return (
    <div className="min-w-[200px]">
      <div className="text-[12px] font-bold leading-snug" style={{ color: C.muted }}>{title}</div>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {rows.map(r => r && (
          <div key={r.label}>
            <div className="flex items-baseline justify-between gap-5">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: r.color }} />{r.label}
              </span>
              <span className="whitespace-nowrap text-[15px] font-bold tabular-nums">{r.value}</span>
            </div>
            {r.sub && <div className="pl-4 text-[11px] font-medium tabular-nums" style={{ color: C.muted }}>{r.sub}</div>}
          </div>
        ))}
      </div>
      {delta && (
        <div className="mt-2 flex items-baseline justify-between gap-5 pt-1.5 text-[13px]" style={{ borderTop: `1px solid ${C.track}` }}>
          <span className="font-medium" style={{ color: C.muted }}>Изменение</span>
          <span className="whitespace-nowrap font-bold tabular-nums" style={{ color: delta.color }}>{delta.text}</span>
        </div>
      )}
      {hint && <div className="mt-1.5 text-[11px] font-medium leading-snug" style={{ color: C.muted }}>{hint}</div>}
    </div>
  );
}

/** «Снять выбор» — рядом с легендой, когда на графике выбран день / месяц. */
function Unpin({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="Вернуть итог периода (или Esc)"
      className="min-h-[28px] cursor-pointer rounded-md px-2 text-[12px] font-bold leading-none underline underline-offset-2" style={{ color: C.primary }}>Снять выбор</button>
  );
}

function Legend({ items }: { items: { color: string; opacity?: number; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] font-medium">
      {items.map(it => (
        <span key={it.label} className="inline-flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: it.color, opacity: it.opacity ?? 1 }} />{it.label}
        </span>
      ))}
    </div>
  );
}

/** Поле графика: шкала слева, сетка, подписи снизу. children получает h(v) — долю высоты (0…1). */
function Plot({ max, yLabel, xTitle, labels, colMin, active, children }: {
  max: number; yLabel: string; xTitle: string; colMin: number;
  /** Выбранный столбец (сейчас подписи под графиком его никак не отмечают). */
  active?: number | null;
  /** caps — подписи прямо под столбцами пары («прошлая», «эта»), в тех же пропорциях, что столбцы. */
  /** lines — свои строки подписи вместо label/sub (каждая со своим цветом). */
  labels: { key: string; label: string; sub?: string | null; dim?: boolean; note?: { text: string; color: string } | null; caps?: { text: string; dim?: boolean }[]; lines?: { text: string; color: string; bold?: boolean }[] }[];
  children: (h: (v: number) => number) => ReactNode;
}) {
  const { top, step } = niceScale(max);
  const ticks: number[] = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);
  const h = (v: number) => v / top;
  const axisW = Math.max(40, nf.format(top).length * 8 + 16);
  const dense = labels.length > 14;
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: axisW + labels.length * colMin }}>
        <div className="mb-1 text-[12px] font-medium" style={{ color: C.muted }}>{yLabel}</div>
        <div className="flex">
          <div className="relative shrink-0" style={{ width: axisW, height: CHART_H }}>
            {ticks.map(t => (
              <span key={t} className="absolute right-2 text-[12px] tabular-nums" style={{ bottom: `${h(t) * 100}%`, transform: 'translateY(50%)', color: C.muted }}>{nf.format(t)}</span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1" style={{ height: CHART_H }}>
            {ticks.map(t => <div key={t} className="absolute inset-x-0" style={{ bottom: `${h(t) * 100}%`, borderTop: `1px solid ${t === 0 ? C.line : C.track}` }} />)}
            <div className="absolute inset-0">{children(h)}</div>
          </div>
        </div>
        <div className="flex" style={{ paddingLeft: axisW }}>
          {labels.map((l, i) => (
            <div key={l.key} className={`min-w-0 flex-1 text-center leading-tight ${l.caps ? 'pt-1' : 'pt-2'}`} style={{ opacity: l.dim ? 0.5 : 1 }}>
              {l.caps && (
                <div className="flex justify-center gap-[6%] pb-1.5">
                  {l.caps.map(c => (
                    <span key={c.text} className="inline-flex w-[38%] max-w-[72px] justify-center whitespace-nowrap font-medium leading-none" style={{ fontSize: labels.length >= 12 ? 9 : 10, color: C.muted, opacity: c.dim ? 0.35 : 1 }}>{c.text}</span>
                  ))}
                </div>
              )}
              {l.lines ? l.lines.map((ln, k) => (
                <div key={k} className={`whitespace-nowrap tabular-nums ${ln.bold ? 'font-bold' : 'font-medium'}`} style={{ fontSize: k === 0 ? 12 : dense ? 10 : 11, color: ln.color }}>{ln.text}</div>
              )) : (
                <>
                  <div className="whitespace-nowrap font-medium" style={{ fontSize: dense ? 12 : 13 }}>{l.label}</div>
                  {l.sub && <div className="whitespace-nowrap text-[11px]" style={{ color: C.muted }}>{l.sub}</div>}
                </>
              )}
              {l.note && <div className="mt-1 whitespace-nowrap text-[13px] font-bold tabular-nums" style={{ color: l.note.color }}>{l.note.text}</div>}
            </div>
          ))}
        </div>
        <div className="mt-2 text-center text-[13px] font-medium" style={{ paddingLeft: axisW, color: C.muted }}>{xTitle}</div>
      </div>
    </div>
  );
}

/** Один столбец пары. solid — нижняя «плотная» часть (база сегодняшнего дня до того же времени). */
function PairBar({ value, h, color, solid, title, small, fmt, label }: { value: number | null; h: (v: number) => number; color: string; solid?: number | null; title: string; /** свой вид числа над столбцом (проценты, миллионы) */ fmt?: (v: number) => string; /** готовая подпись вместо числа (обрезанный столбец: высота по шкале, число настоящее) */ label?: string; /** узкие столбцы: число над столбцом вертикально; 'auto' (год) — вертикально, пока сама карточка (@container/card) уже 1300px, шире — как в неделе */ small: boolean | 'auto' }) {
  const vertical = { fontSize: 10, writingMode: 'vertical-rl', transform: 'rotate(180deg)' } as const;
  const num = label ?? (value != null ? (fmt ? fmt(value) : nf.format(Math.round(value))) : '');
  return (
    <div className="flex h-full w-[38%] max-w-[72px] flex-col items-center justify-end" title={title}>
      {value != null && (
        <>
          {small === 'auto' ? (
            <>
              <span className="mb-1 whitespace-nowrap font-bold leading-none tabular-nums @[1300px]/card:hidden" style={vertical}>{num}</span>
              <span className="mb-1 hidden whitespace-nowrap text-[12px] font-bold leading-none tabular-nums @[1300px]/card:inline">{num}</span>
            </>
          ) : (
            <span className="mb-1 whitespace-nowrap font-bold leading-none tabular-nums" style={small ? vertical : { fontSize: 13 }}>{num}</span>
          )}
          <div className="relative w-full overflow-hidden rounded-t-[3px]" style={{ height: `${h(value) * 100}%`, minHeight: value > 0 ? 2 : 0 }}>
            <div className="absolute inset-0" style={{ background: color, opacity: solid != null ? 0.4 : 1 }} />
            {solid != null && value > 0 && <div className="absolute inset-x-0 bottom-0" style={{ height: `${Math.min(1, solid / value) * 100}%`, background: color }} />}
          </div>
        </>
      )}
    </div>
  );
}

/** «1–8 окт» — числа месяца с первого по upto. */
const monthDates = (upto: number, m: number) => (upto <= 1 ? `1 ${MONTHS_SHORT[m]}` : `1–${upto} ${MONTHS_SHORT[m]}`);
/** «3 сен». */
const dayShort = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS_SHORT[Number(d.slice(5, 7)) - 1]}`;
/** «1.10» — дата под столбцом месяца: 31 день должен помещаться в карточку шириной в половину ряда. */
const dayNum = (d: string) => `${Number(d.slice(8, 10))}.${d.slice(5, 7)}`;
/** База месяца — те же дни недели четырьмя неделями раньше (решение владельца 09.10: «сравнивать
 *  подобное с подобным, а не пятницу с понедельником»). */
const MONTH_BASE = '4 недели назад';

/** Месяц накопительно: сколько сделок набрано к каждому числу — против тех же дней недели
 *  четырьмя неделями раньше (та же база, что у графика по дням). */
function MonthCompare({ resp, cmp, nodeId, nodeTitle, tags }: { resp: DashPeriodResponse; cmp: DashCompareMonth; nodeId: string | null; nodeTitle: string; tags: FilterTag[] }) {
  const s = cmp.series.find(x => x.id === nodeId) ?? cmp.series[0];
  const curName = monthName(resp.from);
  const cur = cmp.current;
  const cm = Number(resp.from.slice(5, 7)) - 1;
  const dayOf = (i: number) => `${resp.from.slice(0, 8)}${String(i + 1).padStart(2, '0')}`;
  const baseDayOf = (i: number) => addDays(dayOf(i), -cmp.shiftDays);
  const n = cmp.curDays;
  const max = Math.max(0, ...s.cur, ...s.base);
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const line = (pts: number[], h: (v: number) => number) => pts.map((v, i) => `${x(i)},${100 - h(v) * 100}`).join(' ');
  const last = s.cur.length - 1;
  const baseEnd = s.base.length - 1;
  const curAbove = s.cur[last] >= (cur ? s.baseTotal : s.base[baseEnd] ?? 0);
  const ringX = x(Math.min(last, Math.max(baseEnd, 0)));
  // подсветка, подсказки и выбор дня — общие с остальными графиками месяца
  const frame = frameOf(resp, cmp);
  const { active, pin, col, unpin } = useFx(frame.scope);
  const sel = pin != null && pin <= last ? pin : null;
  /** Накоплено в базе к дню i; у сегодняшнего дня — на то же время. */
  const baseAt = (i: number): number | null => (i === last && cur ? s.baseTotal : s.base[i] ?? null);
  const pctAt = (i: number) => {
    const b = baseAt(i);
    if (i > last || b == null || b <= 0) return null;
    const d = ((s.cur[i] - b) / b) * 100;
    return { text: `${signed(d, nf1.format(Math.abs(d)))}%`, color: d > 0 ? C.successText : d < 0 ? C.error : C.muted };
  };
  const tipOf = (i: number) => () => {
    const b = baseAt(i);
    return (
      <TipBox title="Сделки с начала месяца" delta={pctAt(i)}
        hint={PIN_ON_CLICK ? 'Этот день показан сверху на всех графиках. Нажмите на него ещё раз — вернуть итог периода.' : undefined}
        rows={[
          i <= last ? { color: C.primary, label: `по ${dayShort(dayOf(i))}`, value: nf.format(s.cur[i]) } : null,
          b != null ? { color: C.base, label: `по ${dayShort(baseDayOf(i))}${i === last && cur?.cutoffTime ? ', на то же время' : ''}`, value: nf.format(b) } : null,
        ]} />
    );
  };
  return (
    <div className="@container/card min-w-0 p-4 sm:p-5" style={card}>
      <CardTitle tags={tags}>Сделки с начала месяца, накопительно</CardTitle>
      <div className="mt-0.5 text-[13px] font-medium" style={{ color: C.muted }}>{nodeTitle} · сколько сделок набрано к каждому числу · серая линия — те же дни недели {MONTH_BASE}</div>
      {/* итог и общее отклонение за период — те же три числа, что на графике по дням (правка владельца 09.10) */}
      <div className={KPI_GRID}>
        {sel == null ? (
          <>
            <Kpi label={cur ? `${curName}, по сегодня · ${monthDates(cur.day, cm)}` : `${curName} · весь месяц`}>{nf.format(s.curTotal)}</Kpi>
            <Kpi label={`${cap(MONTH_BASE)}, те же дни недели · ${cur ? shortRange(cmp.baseFrom, baseDayOf(cur.day - 1)) : shortRange(cmp.baseFrom, cmp.baseTo)}`}>{nf.format(s.baseTotal)}</Kpi>
            <Kpi label="Отклонение, день ко дню"><Delta cur={s.curTotal} base={s.baseTotal} /></Kpi>
          </>
        ) : (
          // выбран день: сколько набрано с начала месяца по этот день
          <>
            <Kpi on label={`Выбрано · ${monthDates(sel + 1, cm)}`}>{nf.format(s.cur[sel])}</Kpi>
            <Kpi on label={`${cap(MONTH_BASE)} · ${shortRange(cmp.baseFrom, baseDayOf(sel))}`}>{baseAt(sel) != null ? nf.format(baseAt(sel)!) : '—'}</Kpi>
            <Kpi on label="Отклонение по этот день"><Delta cur={s.cur[sel]} base={baseAt(sel)} /></Kpi>
          </>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <Legend items={[{ color: C.base, label: `${cap(MONTH_BASE)} (${shortRange(cmp.baseFrom, cmp.baseTo)})` }, { color: C.primary, label: curName }]} />
        {sel != null && <Unpin onClick={unpin} />}
      </div>
      <div className="mt-3">
        <Plot max={max * 1.08} yLabel="Сделок с начала месяца" xTitle={`День недели · синим — дата ${MONTHS_GEN[cm]}, серым — дата ${MONTH_BASE}, с которой она сравнивается`} colMin={31} active={active}
          labels={Array.from({ length: n }, (_, i) => ({
            key: String(i), label: String(i + 1), dim: i > last,
            lines: [
              { text: cap(WEEKDAYS_SHORT[weekdayIndex(dayOf(i))]), color: C.text, bold: true },
              { text: dayNum(dayOf(i)), color: C.primary, bold: true },
              { text: dayNum(baseDayOf(i)), color: C.muted },
            ],
          }))}>
          {h => (
            <>
              {/* под линиями — полоса подсвеченного дня; прозрачные столбцы поверх всего ловят мышь (в конце) */}
              <div className="absolute inset-0 flex" aria-hidden>
                {Array.from({ length: n }, (_, i) => <div key={i} className="h-full min-w-0 flex-1" style={{ borderRadius: 6, background: active === i ? C.mutedBg : undefined, boxShadow: pin === i ? `inset 0 0 0 2px ${C.primary}` : undefined, transition: 'background-color .12s' }} />)}
              </div>
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                <polyline points={line(s.base, h)} fill="none" style={{ stroke: C.base }} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <polyline points={line(s.cur, h)} fill="none" style={{ stroke: C.primary }} strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
              {s.base.map((v, i) => (
                <span key={`b${i}`} className="absolute -translate-x-1/2 translate-y-1/2 rounded-full" style={{ left: `${x(i)}%`, bottom: `${h(v) * 100}%`, width: active === i ? 10 : 7, height: active === i ? 10 : 7, background: C.base }} />
              ))}
              {s.cur.map((v, i) => (
                <span key={`c${i}`} className="absolute -translate-x-1/2 translate-y-1/2 rounded-full" style={{ left: `${x(i)}%`, bottom: `${h(v) * 100}%`, width: active === i ? 13 : 9, height: active === i ? 13 : 9, background: C.primary }} />
              ))}
              {/* отклонение накопленного итога на каждый день (правка владельца 09.10); у сегодняшней
                  точки база — на то же время. Стоит над верхней из двух точек; у последней — выше,
                  чтобы не налезать на подписи концов линий. */}
              {s.cur.map((v, i) => {
                const base = i === last && cur ? s.baseTotal : s.base[i];
                if (base == null || base <= 0) return null;
                const r = Math.round(((v - base) / base) * 100);
                return (
                  <span key={`p${i}`} className="absolute -translate-x-1/2 whitespace-nowrap rounded-md px-0.5 py-0.5 text-[10px] font-bold leading-none tabular-nums"
                    style={{ left: `${x(i)}%`, bottom: `calc(${h(Math.max(v, base)) * 100}% + ${i === last ? 30 : 10}px)`, color: r > 0 ? C.successText : r < 0 ? C.error : C.muted, background: C.mutedBg }}>{signed(r, String(Math.abs(r)))}%</span>
                );
              })}
              {/* конец синей линии; у идущего месяца — ещё и база «на тот же момент» (кольцо) */}
              <span className="absolute whitespace-nowrap text-[13px] font-bold tabular-nums" style={{ left: `${x(last)}%`, bottom: `${h(s.cur[last]) * 100}%`, transform: `translate(-50%, ${curAbove ? '-10px' : 'calc(100% + 12px)'})`, color: C.primary }}>{nf.format(s.cur[last])}</span>
              {cur && (
                <>
                  <span className="absolute h-[11px] w-[11px] -translate-x-1/2 translate-y-1/2 rounded-full" style={{ left: `${ringX}%`, bottom: `${h(s.baseTotal) * 100}%`, border: `2px solid ${C.base}`, background: C.surface }}
                    title={`${cap(MONTH_BASE)} на тот же момент: ${nf.format(s.baseTotal)}`} />
                  <span className="absolute whitespace-nowrap text-[12px] font-bold tabular-nums" style={{ left: `${ringX}%`, bottom: `${h(s.baseTotal) * 100}%`, transform: `translate(-50%, ${curAbove ? 'calc(100% + 12px)' : '-12px'})`, color: C.muted }}>{nf.format(s.baseTotal)}</span>
                </>
              )}
              {/* у идущего месяца конец серой линии совпадает с кольцом «на тот же момент» — второе число там лишнее */}
              {baseEnd >= 0 && !(cur && baseEnd === last) && (
                <span className="absolute whitespace-nowrap text-[12px] font-bold tabular-nums" style={{ left: `${x(baseEnd)}%`, bottom: `${h(s.base[baseEnd]) * 100}%`, transform: `translate(-80%, ${!cur && curAbove ? 'calc(100% + 12px)' : '-10px'})`, color: C.muted }}>{nf.format(s.base[baseEnd])}</span>
              )}
              <div className="absolute inset-0 flex">
                {Array.from({ length: n }, (_, i) => <div key={i} className="h-full min-w-0 flex-1 cursor-pointer" {...col(i, tipOf(i))} />)}
              </div>
            </>
          )}
        </Plot>
      </div>
      <div className="mt-3 text-[12px] leading-snug" style={{ color: C.muted }}>
        Линии — сколько сделок создано с начала месяца к концу каждого дня. Серая — те же дни недели четырьмя неделями раньше. Синяя выше серой — месяц идёт с опережением, ниже — отстаёт. Проценты — на сколько накопленный итог на этот день больше или меньше.
        {cur && ` Кольцо на серой линии — база по тот же день${cur.cutoffTime ? ` и то же время (до ${cur.cutoffTime})` : ''}.`}
      </div>
    </div>
  );
}

// ───────────────────────────── филиалы между собой ─────────────────────────────

/** Строка сравнения (филиал или департамент): ids — узлы, чьи сделки складываются. */
export interface PeriodRow { key: string; name: string; short: string; ids: string[] }
interface PeriodBranch { id: string; name: string; short: string }

const addArr = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] ?? 0));
const addNum = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

/** Ответ периода с добавленными «сборными» сериями: у каждой группы id = её key, значения —
 *  сумма серий её узлов (все числа сравнения — штуки и накопления, складываются напрямую). */
function withGroups(resp: DashPeriodResponse, groups: { key: string; name: string; ids: string[] }[]): DashPeriodResponse {
  const series = [...resp.series];
  for (const g of groups) {
    const parts = resp.series.filter(x => g.ids.includes(x.id));
    const values = parts.reduce((acc, p) => addArr(acc, p.values), resp.buckets.map(() => 0));
    series.push({ id: g.key, name: g.name, values, total: values.reduce((a, v) => a + v, 0) });
  }
  const extra = resp.extra
    ? Object.fromEntries(Object.entries(resp.extra).map(([k, c]) => [k, groupCompare(c, groups)])) as DashPeriodResponse['extra']
    : resp.extra;
  return { ...resp, series, compare: groupCompare(resp.compare, groups), extra };
}
/** Сравнение с добавленными сборными сериями групп (сумма серий их узлов). */
function groupCompare(input: DashCompare | null, groups: { key: string; ids: string[] }[]): DashCompare | null {
  let compare = input;
  if (compare?.mode === 'week') {
    const c = compare;
    compare = { ...c, series: [...c.series, ...groups.flatMap(g => {
      const parts = c.series.filter(x => g.ids.includes(x.id));
      if (parts.length === 0) return [];
      return [parts.slice(1).reduce((a, p) => ({ id: g.key, cur: addArr(a.cur, p.cur), base: addArr(a.base, p.base), basePartial: addNum(a.basePartial, p.basePartial), curTotal: a.curTotal + p.curTotal, baseTotal: a.baseTotal + p.baseTotal }), { ...parts[0], id: g.key })];
    })] };
  } else if (compare?.mode === 'month') {
    const c = compare;
    compare = { ...c, series: [...c.series, ...groups.flatMap(g => {
      const parts = c.series.filter(x => g.ids.includes(x.id));
      if (parts.length === 0) return [];
      return [parts.slice(1).reduce((a, p) => ({ id: g.key, cur: addArr(a.cur, p.cur), base: addArr(a.base, p.base), curTotal: a.curTotal + p.curTotal, baseTotal: a.baseTotal + p.baseTotal }), { ...parts[0], id: g.key })];
    })] };
  } else if (compare?.mode === 'year') {
    const c = compare;
    compare = { ...c, series: [...c.series, ...groups.flatMap(g => {
      const parts = c.series.filter(x => g.ids.includes(x.id));
      if (parts.length === 0) return [];
      return [parts.slice(1).reduce((a, p) => ({ id: g.key, cur: addArr(a.cur, p.cur), base: addArr(a.base, p.base), basePartial: addNum(a.basePartial, p.basePartial), curTotal: a.curTotal + p.curTotal, baseTotal: a.baseTotal + p.baseTotal }), { ...parts[0], id: g.key })];
    })] };
  }
  return compare;
}
const CITY_COLORS = [C.primary, C.city2, C.city3, C.city4, C.base];
// У филиалов цвет постоянный, а не по порядку (решение владельца 09.10): Питер — синий,
// Москва — зелёный, Краснодар — красный. Новый филиал и департаменты берут запасные цвета.
const BRANCH_COLORS: Record<string, string> = { 'СПБ': C.primary, 'МСК': C.cityMsk, 'КРД': C.cityKrd };
const SPARE_COLORS = [C.city2, C.city4, C.city3, C.base];

/** Пара «текущее / база» филиала для отклонения — те же числа, что в карточке сравнения периода. */
function branchPair(resp: DashPeriodResponse, id: string): { cur: number | null; base: number | null } | null {
  const s = resp.compare?.series.find(x => x.id === id);
  return s ? { cur: s.curTotal, base: s.baseTotal } : null;
}

/** Короткое отклонение одной строкой: «↑ +1,1% к прошлой неделе». */
function DeltaLine({ pair, to }: { pair: { cur: number | null; base: number | null } | null; to: string }) {
  if (!pair || pair.cur == null || pair.base == null || pair.base <= 0) return <span style={{ color: C.muted }}>нет сравнения</span>;
  const pct = ((pair.cur - pair.base) / pair.base) * 100;
  const Icon = pct >= 0 ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <span className="inline-flex items-center gap-0.5 font-bold" style={{ color: pct > 0 ? C.successText : pct < 0 ? C.error : C.text }}>
        <Icon size={15} className="shrink-0" />{signed(pct, nf1.format(Math.abs(pct)))}%
      </span>
      <span style={{ color: C.muted }}>{to}</span>
    </span>
  );
}

/** «Сделки по филиалам / департаментам»: итоги строк за период и график, где они стоят рядом.
 *  rows — id серий (в т.ч. сборных, см. withGroups); scopeId — серия итога для доли. */
function BranchCompare({ resp, branches, title, scopeId, tags, onPick }: {
  resp: DashPeriodResponse; branches: PeriodBranch[]; title: string; scopeId: string; tags: FilterTag[];
  /** Нажали на плитку филиала / департамента — включить фильтр по нему. */
  onPick?: (b: PeriodBranch) => void;
}) {
  const { active, pin, col, look, unpin } = useFx(`${resp.period}|${resp.from}`);
  const found = branches.map(b => ({ b, s: resp.series.find(x => x.id === b.id) }))
    .filter((x): x is { b: PeriodBranch; s: DashPeriodResponse['series'][number] } => !!x.s);
  const anyFixed = found.some(r => BRANCH_COLORS[r.b.short]);
  let spare = 0;
  const rows = found.map((r, i) => ({
    ...r,
    color: BRANCH_COLORS[r.b.short] ?? (anyFixed ? SPARE_COLORS[spare++ % SPARE_COLORS.length] : CITY_COLORS[i % CITY_COLORS.length]),
  }));
  if (rows.length < 2) return null;
  // итог выбранного среза (все филиалы / город / департамент): за период и по каждому дню
  const scope = resp.series.find(x => x.id === scopeId);
  const all = scope?.total ?? 0;
  const to = resp.period === 'week' ? (resp.offset === 0 ? 'к прошлой неделе' : 'к предыдущей неделе') : resp.period === 'month' ? 'к тем же дням 4 недели назад' : 'к прошлому году';
  const bars = barsOf(resp);
  const max = Math.max(0, ...rows.flatMap(r => r.s.values));
  const month = resp.period === 'month';
  // узкие столбцы (месяц, год по филиалам): числа над ними вертикально
  const dense = bars.length * rows.length > 24;
  // выбран день / месяц: плитки и итог показывают его, а не весь период
  const sel = pin != null && pin < bars.length && !bars[pin].future ? pin : null;
  const unit = resp.period === 'year' ? 'месяц' : 'день';
  /** Сделки строки за выбранный столбец и то же в прошлом периоде (у идущего дня — на то же время). */
  const pairAt = (id: string, i: number) => {
    const bk = bucketsOf(resp, resp.compare, id);
    if (!bk) return null;
    return { cur: bk.cur[i] ?? null, base: i === bk.pi && bk.basePartial != null ? bk.basePartial : bk.base[i] ?? null };
  };
  const tipOf = (i: number) => () => (
    <TipBox title={`${title} · ${bars[i].title}`}
      hint={PIN_ON_CLICK ? `Этот ${unit} показан сверху на всех графиках. Нажмите на него ещё раз — вернуть итог периода.` : undefined}
      rows={[
        ...rows.map(r => ({ color: r.color, label: r.b.short === r.b.name ? r.b.name : `${r.b.short} · ${r.b.name}`, value: nf.format(r.s.values[i]), sub: scope && scope.values[i] > 0 ? `доля ${nf1.format((r.s.values[i] / scope.values[i]) * 100)}%` : null })),
        scope ? { color: 'transparent', label: `Итого · ${scope.name}`, value: nf.format(scope.values[i]) } : null,
      ]} />
  );
  return (
    <div className="@container/card min-w-0 p-4 sm:p-5" style={card}>
      {/* итог стоит справа от названия при любой ширине карточки (раньше в узкой карточке падал под
          название и повисал слева); на телефоне — под названием, по левому краю */}
      <div className="flex flex-col gap-x-5 gap-y-2 @[460px]/card:flex-row @[460px]/card:items-start @[460px]/card:justify-between">
        <div className="min-w-0 @[460px]/card:flex-1">
          <CardTitle tags={tags}>{title}</CardTitle>
          <div className="mt-0.5 text-[13px] font-medium" style={{ color: C.muted }}>Сколько сделок создано {resp.period === 'year' ? 'в каждом месяце' : 'в каждый день'} · {resp.label}</div>
        </div>
        {/* итог по всем строкам карточки (правка владельца 09.10: «итого по филиалам») */}
        <div className="@[460px]/card:shrink-0 @[460px]/card:text-right">
          <div className="text-[12px] font-medium @[760px]/card:text-[13px]" style={{ color: sel != null ? C.primary : C.muted }}>{sel != null ? `Выбрано · ${bars[sel].title}` : 'Итого'} · {scope?.name ?? ''}</div>
          <div className="text-[22px] font-bold leading-tight tabular-nums @[760px]/card:text-[28px]" style={{ color: C.text }}>{nf.format(sel != null ? scope?.values[sel] ?? 0 : all)}</div>
          <div className="text-[13px] tabular-nums"><DeltaLine pair={sel != null ? pairAt(scopeId, sel) : branchPair(resp, scopeId)} to={sel != null ? `к тому же ${resp.period === 'year' ? 'месяцу' : 'дню'}` : to} /></div>
        </div>
      </div>
      {/* плитки строк: до четырёх — всегда в один ряд (в узкой карточке мельче), больше — сколько влезет */}
      <div className={rows.length <= 4 ? 'mt-3 grid grid-cols-1 gap-2 @[560px]/card:grid-cols-[repeat(var(--cols),minmax(0,1fr))] @[760px]/card:gap-3' : 'mt-3 grid gap-2 @[760px]/card:gap-3'}
        style={rows.length <= 4 ? { '--cols': rows.length } as CSSProperties : { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))' }}>
        {rows.map(r => { const part = sel != null ? r.s.values[sel] : r.s.total; const whole = sel != null ? scope?.values[sel] ?? 0 : all; return (
          // плитка — кнопка: нажали — фильтр по этому филиалу / департаменту
          <div key={r.b.id} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined} title={onPick ? `Показать только ${r.b.name}` : undefined}
            onClick={onPick ? () => onPick(r.b) : undefined} onKeyDown={onPick ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.b); } } : undefined}
            className={`min-w-0 rounded-[10px] px-3 py-2.5 @[760px]/card:px-4 @[760px]/card:py-3 ${onPick ? 'dt-click' : ''}`} style={{ background: C.mutedBg, boxShadow: sel != null ? `inset 0 0 0 2px ${C.primary}` : undefined }}>
            <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium" style={{ color: C.muted }}>
              <span className="inline-block h-3 w-3 shrink-0 rounded-[3px]" style={{ background: r.color }} />
              <span className="font-bold" style={{ color: C.text }}>{r.b.short}</span>
              {r.b.short !== r.b.name && <span className="min-w-0 truncate">{r.b.name}</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5">
              <span className="text-[22px] font-bold leading-tight tabular-nums @[760px]/card:text-[28px]">{nf.format(part)}</span>
              <span className="text-[13px] font-medium tabular-nums @[760px]/card:text-[14px]" style={{ color: C.muted }}>{whole > 0 ? `доля ${nf1.format((part / whole) * 100)}%` : ''}</span>
            </div>
            <div className="mt-0.5 text-[12px] tabular-nums @[760px]/card:text-[13px]"><DeltaLine pair={sel != null ? pairAt(r.b.id, sel) : branchPair(resp, r.b.id)} to={sel != null ? `к тому же ${resp.period === 'year' ? 'месяцу' : 'дню'}` : to} /></div>
          </div>
        ); })}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <Legend items={[...rows.map(r => ({ color: r.color, label: r.b.short })), { color: C.line, label: resp.period === 'year' ? 'итого за месяц — число в плашке' : 'итого за день — число в плашке' }]} />
        {sel != null && <Unpin onClick={unpin} />}
      </div>
      <div className="mt-3">
        {/* max с запасом: над столбцами дня стоит ещё плашка с итогом */}
        <Plot max={max * 1.12} yLabel={resp.period === 'year' ? 'Сделок в месяц' : 'Сделок в день'} xTitle={resp.period === 'year' ? 'Месяц' : 'День'}
          colMin={dense ? (resp.period === 'month' ? 5 + rows.length * 9 : 8 + rows.length * 12) : 16 + rows.length * 20} active={active}
          labels={bars.map(b => ({ key: b.key, label: b.label, sub: b.sub, dim: b.future }))}>
          {h => (
            // Филиалы столбцами рядом на всех периодах (правка владельца 09.10: в месяце были
            // линии). Где столбцы узкие (месяц, год), числа над ними повёрнуты вертикально.
            <div className="flex h-full items-end">
              {bars.map((b, i) => (
                <div key={b.key} className="relative flex h-full min-w-0 flex-1 items-end justify-center" style={{ gap: dense ? 1 : '3%', ...(b.future ? {} : look(i)) }} {...(b.future ? {} : col(i, tipOf(i)))}>
                  {!b.future && scope && (() => {
                    const top = Math.max(...rows.map(r => r.s.values[i]));
                    // плашка стоит над числами самого высокого столбца (в плотном режиме числа вертикальные)
                    const lift = dense ? 10 + nf.format(top).length * 6.5 : 22;
                    return (
                      <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md px-1 py-0.5 font-bold leading-none tabular-nums"
                        style={{ bottom: `calc(${h(top) * 100}% + ${lift}px)`, fontSize: dense ? 11 : 13, color: C.text, background: C.mutedBg, opacity: b.current ? 0.6 : 1 }}
>{nf.format(scope.values[i])}</span>
                    );
                  })()}
                  {rows.map(r => (
                    <div key={r.b.id} className="flex h-full flex-col items-center justify-end" style={{ width: `${(dense ? 90 : 82) / rows.length}%`, maxWidth: 64 }}>
                      {!b.future && (
                        <>
                          <span className="mb-1 whitespace-nowrap font-bold leading-none tabular-nums"
                            style={dense ? { fontSize: 10, writingMode: 'vertical-rl', transform: 'rotate(180deg)' } : { fontSize: rows.length >= 3 ? 11 : 13 }}>{nf.format(r.s.values[i])}</span>
                          <div className="w-full rounded-t-[3px]" style={{ height: `${h(r.s.values[i]) * 100}%`, minHeight: r.s.values[i] > 0 ? 2 : 0, background: r.color, opacity: b.current ? 0.55 : 1 }} />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Plot>
      </div>
      <div className="mt-3 text-[12px] leading-snug" style={{ color: C.muted }}>
        Крупное число — сделки, созданные за весь выбранный период{resp.offset === 0 ? ' на сейчас' : ''}, доля — от итога. Число в плашке над столбцами — итого за {resp.period === 'year' ? 'месяц' : 'день'}. Изменение {to} посчитано так же, как в карточке сравнения выше
        {resp.period === 'month' ? ' (те же дни недели четырьмя неделями раньше)' : resp.offset > 0 ? ' (период целиком к периоду целиком)' : resp.period === 'week' ? ' (день ко дню: те же дни недели)' : ' (по те же даты года)'}.{resp.period === 'year' && ' Январь считается с 10 января.'}
        {resp.offset === 0 && (resp.period === 'year' ? ' Светлые столбцы — текущий месяц, он ещё не закончился.' : ' Светлые столбцы — сегодня, день ещё не закончился.')}
      </div>
    </div>
  );
}

// ───────────────────── брони и продажи: конверсии и сумма продаж ─────────────────────
// Блоки «Брони» и «Продажи» (правка владельца 09.10). Графики устроены как сравнение сделок
// того же периода: пары столбцов «было → стало», над парой — изменение, сверху три числа итога.

type PlotLabel = Parameters<typeof Plot>[0]['labels'][number];

/** Показатель по столбцам графика (дни недели, числа месяца или месяцы года) в едином виде. */
interface Buckets {
  /** null — столбец ещё не наступил. */
  cur: (number | null)[];
  base: (number | null)[];
  /** Идущий столбец (сегодня / текущий месяц) и его база на тот же момент. */
  pi: number | null;
  basePartial: number | null;
  curTotal: number;
  baseTotal: number;
}

function bucketsOf(resp: DashPeriodResponse, cmp: DashCompare | null | undefined, id: string): Buckets | null {
  if (!cmp) return null;
  if (cmp.mode === 'week') {
    const s = cmp.series.find(x => x.id === id);
    if (!s) return null;
    return { cur: s.cur.map((v, i) => (resp.buckets[i] > resp.today ? null : v)), base: s.base, pi: cmp.partialIndex, basePartial: s.basePartial, curTotal: s.curTotal, baseTotal: s.baseTotal };
  }
  if (cmp.mode === 'month') {
    const s = cmp.series.find(x => x.id === id);
    if (!s) return null;
    const daily = (cum: number[]) => cum.map((v, i) => v - (i > 0 ? cum[i - 1] : 0));
    const dc = daily(s.cur), db = daily(s.base);
    const ti = cmp.current ? cmp.current.day - 1 : null;
    const basePartial = cmp.current?.cutoffTime && ti != null && ti < db.length ? s.baseTotal - (ti > 0 ? s.base[ti - 1] : 0) : null;
    const at = (a: number[]) => Array.from({ length: cmp.curDays }, (_, i) => (i < a.length ? a[i] : null));
    return { cur: at(dc), base: at(db), pi: ti, basePartial, curTotal: s.curTotal, baseTotal: s.baseTotal };
  }
  const s = cmp.series.find(x => x.id === id);
  if (!s) return null;
  const pi = cmp.current ? cmp.uptoMonth - 1 : null;
  return { cur: s.cur.map((v, i) => (pi != null && i > pi ? null : v)), base: s.base, pi, basePartial: s.basePartial, curTotal: s.curTotal, baseTotal: s.baseTotal };
}

/** Всё, что у графика зависит от периода, а не от показателя: подписи, легенда, названия итогов. */
interface Frame {
  small: boolean | 'auto';
  colMin: number;
  xTitle: string;
  /** «в день» / «в месяц». */
  per: string;
  /** Что с чем сравнивается — в подзаголовок карточки. */
  sub: string;
  labels: PlotLabel[];
  curLegend: string; baseLegend: string;
  curKpi: string; baseKpi: string; deltaKpi: string;
  pillTitle: string;
  /** Идущий день / месяц: с чем и на какое время он сравнивается. */
  partialNote: string | null;
  /** Ключ общей подсветки и выбора: графики одного периода подсвечивают один и тот же столбец. */
  scope: string;
  /** Как назвать столбец в подсказке и в итоге выбранного дня: текущий период и база («Вт, 6 окт» / «Вт, 29 сен»). */
  tips: { cur: string; base: string }[];
}

function frameOf(resp: DashPeriodResponse, cmp: DashCompare): Frame {
  if (cmp.mode === 'week') {
    const current = resp.offset === 0;
    const curName = current ? 'Эта неделя' : 'Выбранная неделя', baseName = current ? 'Прошлая неделя' : 'Предыдущая неделя';
    const curDates = shortRange(resp.from, resp.to), baseDates = shortRange(cmp.baseFrom, cmp.baseTo);
    const full = cmp.matched >= 7;
    const curUsed = shortRange(resp.from, addDays(resp.from, cmp.matched - 1));
    const baseUsed = shortRange(cmp.baseFrom, addDays(cmp.baseFrom, cmp.matched - 1));
    return {
      scope: `${resp.period}|${resp.from}`,
      tips: resp.buckets.map((d, i) => ({ cur: `${cap(WEEKDAYS_SHORT[i])}, ${dayShort(d)}`, base: `${cap(WEEKDAYS_SHORT[i])}, ${dayShort(addDays(d, -7))}` })),
      small: false, colMin: 78, xTitle: 'День недели', per: 'в день',
      sub: `неделя ${curDates} против недели ${baseDates}`,
      labels: resp.buckets.map((d, i) => ({
        key: d, label: cap(WEEKDAYS_SHORT[i]), sub: `${Number(d.slice(8, 10))} ${MONTHS_SHORT[Number(d.slice(5, 7)) - 1]}.`, dim: d > resp.today,
        caps: [{ text: current ? 'прошлая' : 'предыд.' }, { text: current ? 'эта' : 'выбр.', dim: d > resp.today }],
      })),
      curLegend: `${curName} (${curDates})`, baseLegend: `${baseName} (${baseDates})`,
      curKpi: full ? `${curName} · ${curUsed}` : `${curName}, по сегодня · ${curUsed}`,
      baseKpi: full ? `${baseName} · ${baseUsed}` : `${baseName}, те же дни · ${baseUsed}`,
      deltaKpi: full ? 'Отклонение, неделя к неделе' : 'Отклонение, день ко дню',
      pillTitle: 'Изменение к тому же дню прошлой недели',
      partialNote: cmp.partialIndex != null && cmp.cutoffTime ? `Сегодня день ещё идёт — он сравнивается с тем же днём прошлой недели на то же время, до ${cmp.cutoffTime}.` : null,
    };
  }
  if (cmp.mode === 'month') {
    const cur = cmp.current;
    const curName = monthName(resp.from);
    const cm = Number(resp.from.slice(5, 7)) - 1;
    const dayOf = (i: number) => `${resp.from.slice(0, 8)}${String(i + 1).padStart(2, '0')}`;
    const baseDayOf = (i: number) => addDays(dayOf(i), -cmp.shiftDays);
    const wd = (d: string) => WEEKDAYS_SHORT[weekdayIndex(d)];
    const baseUsed = cur ? shortRange(cmp.baseFrom, baseDayOf(cur.day - 1)) : shortRange(cmp.baseFrom, cmp.baseTo);
    return {
      scope: `${resp.period}|${resp.from}`,
      tips: Array.from({ length: cmp.curDays }, (_, i) => ({ cur: `${cap(wd(dayOf(i)))}, ${dayShort(dayOf(i))}`, base: `${cap(wd(baseDayOf(i)))}, ${dayShort(baseDayOf(i))}` })),
      small: true, colMin: 31, per: 'в день',
      xTitle: `День недели · синим — дата ${MONTHS_GEN[cm]}, серым — дата ${MONTH_BASE}, с которой она сравнивается`,
      sub: `каждый день — против того же дня недели ${MONTH_BASE}`,
      labels: Array.from({ length: cmp.curDays }, (_, i) => ({
        key: String(i), label: String(i + 1), dim: dayOf(i) > resp.today,
        lines: [
          { text: cap(wd(dayOf(i))), color: C.text, bold: true },
          { text: dayNum(dayOf(i)), color: C.primary, bold: true },
          { text: dayNum(baseDayOf(i)), color: C.muted },
        ],
      })),
      curLegend: curName, baseLegend: `${cap(MONTH_BASE)} (${shortRange(cmp.baseFrom, cmp.baseTo)})`,
      curKpi: cur ? `${curName}, по сегодня · ${monthDates(cur.day, cm)}` : `${curName} · весь месяц`,
      baseKpi: `${cap(MONTH_BASE)}, те же дни недели · ${baseUsed}`,
      deltaKpi: 'Отклонение, день ко дню',
      pillTitle: `Изменение к тому же дню недели ${MONTH_BASE}`,
      partialNote: cur?.cutoffTime ? `Сегодня день ещё идёт — он сравнивается с ${dayShort(baseDayOf(cur.day - 1))} на то же время, до ${cur.cutoffTime}.` : null,
    };
  }
  const curYear = resp.from.slice(0, 4), baseYear = String(cmp.baseYear);
  const cur = cmp.current;
  const pi = cur ? cmp.uptoMonth - 1 : null;
  return {
    scope: `${resp.period}|${resp.from}`,
    // январь в годе — с 10-го (решение владельца 10.10, shared.YEAR_START_MD)
    tips: MONTHS_SHORT.slice(0, resp.buckets.length).map((_, i) => ({ cur: `${MONTHS_NOM[i]} ${curYear}${i === 0 ? ', с 10-го' : ''}`, base: `${MONTHS_NOM[i]} ${baseYear}${i === 0 ? ', с 10-го' : ''}` })),
    small: 'auto', colMin: 54, xTitle: 'Месяц', per: 'в месяц',
    sub: `${curYear} против ${baseYear}`,
    labels: MONTHS_SHORT.slice(0, resp.buckets.length).map((m, i) => ({ key: m, label: m, dim: pi != null && i > pi, caps: [{ text: baseYear }, { text: curYear, dim: pi != null && i > pi }] })),
    curLegend: curYear, baseLegend: baseYear,
    curKpi: cur ? `${curYear}, по сегодня · ${yearRange(curYear, resp.today)}` : `${curYear} · с 10 января`,
    baseKpi: cur ? `${baseYear}, те же даты · ${yearRange(baseYear, cur.baseThrough)}` : `${baseYear} · с 10 января`,
    deltaKpi: cur ? 'Отклонение, день ко дню' : 'Отклонение, год к году',
    pillTitle: `Изменение к тому же месяцу ${baseYear} года`,
    partialNote: `Январь считается с 10 января — в обоих годах. ${cur && pi != null ? `${cap(MONTHS_NOM[pi].toLowerCase())} ещё идёт — он сравнивается с тем же месяцем ${baseYear} года по ту же дату${cur.cutoffTime ? ` и время (до ${cur.cutoffTime})` : ''}.` : ''}`,
  };
}

/** «10 янв – 10 окт»: даты года в счёте (с 10 января); если сегодня ещё 1–9 января — только «10 янв». */
function yearRange(year: string, through: string): string {
  const start = `${year}-${YEAR_START_MD}`;
  return through < start ? shortRange(start, start) : shortRange(start, through);
}

/** Отклонение конверсии в процентных пунктах (27,3% против 25,1% — это +2,2 п.п.). */
function DeltaPP({ cur, base }: { cur: number | null; base: number | null }) {
  if (cur == null || base == null) return <span style={{ color: C.muted }}>—</span>;
  const diff = cur - base;
  const color = diff > 0 ? C.successText : diff < 0 ? C.error : C.text;
  const Icon = diff >= 0 ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-1" style={{ color }}>
      {diff !== 0 && <Icon className="h-[18px] w-[18px] shrink-0 @[760px]/card:h-[22px] @[760px]/card:w-[22px]" />}{signed(diff, nf1.format(Math.abs(diff)))} п.п.
    </span>
  );
}

/** Карточка «пары столбцов по дням / месяцам» для любого показателя: сделки, сумма продаж
 *  (столбцы), конверсии (линии).
 *  delta: 'pct' — изменение в процентах (штуки, суммы), 'pp' — в процентных пунктах (конверсии).
 *  partialMode: 'solid' — серый столбец идущего дня целиком, плотная часть — на то же время;
 *  'replace' — серое значение сразу на то же время (у конверсии «часть столбца» смысла не имеет). */
function PairCard({ title, tags, sub, frame, cur, base, pi, basePartial, partialMode, yLabel, fmt, delta, footer, lines, totals, fmtKpi, deltaKpi, subOf, toggle, accum }: {
  title: string; tags: FilterTag[]; sub: string; frame: Frame;
  cur: (number | null)[]; base: (number | null)[]; pi: number | null; basePartial: number | null;
  partialMode: 'solid' | 'replace';
  yLabel: string;
  fmt: (v: number, short: boolean) => string;
  delta: 'pct' | 'pp';
  footer: ReactNode;
  /** Две линии с точками вместо пар столбцов — так показаны конверсии (правка владельца 09.10:
   *  «сделаем эти графики такими линиями», образец — накопительный график сделок). */
  lines?: boolean;
  /** Итог периода — три числа сверху (пока на графике не выбран день). */
  totals: { cur: number | null; base: number | null; curSub?: string | null; baseSub?: string | null };
  /** Вид числа в плитке сверху. */
  fmtKpi: (v: number) => string;
  /** Плитка «Отклонение». */
  deltaKpi: (cur: number | null, base: number | null) => ReactNode;
  /** Из чего сложилось значение столбца i (конверсии: «броней: 5 · сделок: 20»). */
  subOf?: (i: number) => { cur: string | null; base: string | null };
  /** Переключатель «По дням / Накопительно» — справа от легенды. */
  toggle?: ReactNode;
  /** Накопительный вид: в подсказке «по 6 окт» вместо «6 окт». */
  accum?: boolean;
}) {
  const short = frame.small === true;
  const n = frame.labels.length;
  const { active, pin, col, look, unpin } = useFx(frame.scope);
  const sel = pin != null && pin < n ? pin : null;
  const shown = base.map((v, i) => (partialMode === 'replace' && i === pi && basePartial != null ? basePartial : v));
  /** С чем сравнивается столбец i: у идущего дня / месяца — база на то же время. */
  const eff = (i: number) => (i === pi && basePartial != null ? basePartial : base[i]);
  // Один-два столбца бывают в разы выше остальных (в январе 2025 в базе есть продажа на
  // 247 млрд ₽ — ошибка в сумме сделки; конверсия выходного дня при трёх сделках). Тогда шкала
  // строится по остальным столбцам, а выброс обрезается по верху — со стрелкой и настоящим числом.
  const sorted = [...cur, ...shown].filter((v): v is number => v != null && v > 0).sort((p, q) => q - p);
  const jump = sorted.findIndex((v, i) => i + 1 < sorted.length && v > 6 * sorted[i + 1]);
  const clipped = jump >= 0 && jump < 2 && sorted.length - jump - 1 >= 4;
  const max = clipped ? sorted[jump + 1] * 1.06 : (sorted[0] ?? 0);
  const over = (v: number | null) => clipped && v != null && v > max;
  const text = (v: number) => (over(v) ? `↑ ${fmt(v, short)}` : fmt(v, short));
  // линии: точка столбца — по его середине; разрыв там, где значения нет
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const fs = frame.small === false ? 13 : frame.small === true ? 10 : 11;
  const segments = (vals: (number | null)[], h: (v: number) => number): string[] => {
    const out: string[] = [];
    let run: string[] = [];
    vals.forEach((v, i) => {
      if (v == null) { if (run.length) out.push(run.join(' ')); run = []; }
      else run.push(`${x(i)},${100 - h(Math.min(v, max)) * 100}`);
    });
    if (run.length) out.push(run.join(' '));
    return out;
  };
  /** Изменение столбца i к его базе; compact — целыми (узкие столбцы месяца). */
  const change = (i: number, compact: boolean, unit: boolean) => {
    const c = cur[i], b = eff(i);
    if (c == null || b == null) return null;
    if (delta === 'pct' && b <= 0) return null;
    const raw = delta === 'pp' ? c - b : ((c - b) / b) * 100;
    const d = compact ? Math.round(raw) : raw;
    return { text: `${signed(d, compact ? String(Math.abs(d)) : nf1.format(Math.abs(d)))}${delta === 'pp' ? (unit ? ' п.п.' : '') : '%'}`, color: d > 0 ? C.successText : d < 0 ? C.error : C.muted };
  };
  // «п.п.» над столбцами — только в неделе: в месяце и году столбцы узкие, единица стоит в итоге сверху и в сноске
  const note = (i: number) => change(i, short, frame.small === false);
  const unit = frame.per === 'в месяц' ? 'месяц' : 'день';
  const tipOf = (i: number) => () => {
    const c = cur[i], b = base[i];
    const partial = i === pi && basePartial != null;
    const subs = subOf?.(i);
    return (
      <TipBox title={title} delta={change(i, false, true)}
        hint={PIN_ON_CLICK ? `Этот ${unit} показан сверху на всех графиках. Нажмите на него ещё раз — вернуть итог периода.` : undefined}
        rows={[
          c != null ? { color: C.primary, label: `${accum ? 'по ' : ''}${frame.tips[i].cur}`, value: fmt(c, false), sub: subs?.cur } : null,
          b != null ? { color: C.base, label: `${accum ? 'по ' : ''}${partial ? `${frame.tips[i].base}, на то же время` : frame.tips[i].base}`, value: fmt(partial ? basePartial! : b, false), sub: subs?.base } : null,
          partial && partialMode === 'solid' && b != null ? { color: 'transparent', label: `за весь ${unit}`, value: fmt(b, false) } : null,
        ]} />
    );
  };
  const pillPos = frame.small === false
    ? 'bottom-[calc(var(--pb)+22px)] px-1.5 text-[13px]'
    : frame.small === true
      ? 'bottom-[calc(var(--pb)+var(--lv))] px-0.5 text-[10px]'
      : 'bottom-[calc(var(--pb)+var(--lv))] px-1 text-[11px] @[1300px]/card:bottom-[calc(var(--pb)+22px)] @[1300px]/card:px-1.5 @[1300px]/card:text-[13px]';
  return (
    <div className="@container/card min-w-0 p-4 sm:p-5" style={card}>
      <CardTitle tags={tags}>{title}</CardTitle>
      <div className="mt-0.5 text-[13px] font-medium" style={{ color: C.muted }}>{sub}</div>
      <div className={KPI_GRID}>
        {sel == null ? (
          <>
            <Kpi label={frame.curKpi} sub={totals.curSub}>{totals.cur != null ? fmtKpi(totals.cur) : '—'}</Kpi>
            <Kpi label={frame.baseKpi} sub={totals.baseSub}>{totals.base != null ? fmtKpi(totals.base) : '—'}</Kpi>
            <Kpi label={frame.deltaKpi}>{deltaKpi(totals.cur, totals.base)}</Kpi>
          </>
        ) : (
          // выбран день / месяц: вместо итога периода — его цифры
          <>
            <Kpi on label={`Выбрано · ${frame.tips[sel].cur}`} sub={subOf?.(sel).cur}>{cur[sel] != null ? fmtKpi(cur[sel]!) : '—'}</Kpi>
            <Kpi on label={`${frame.tips[sel].base}${sel === pi && basePartial != null ? ', на то же время' : ''}`} sub={subOf?.(sel).base}>{eff(sel) != null ? fmtKpi(eff(sel)!) : '—'}</Kpi>
            <Kpi on label={`Отклонение за этот ${unit}`}>{deltaKpi(cur[sel], eff(sel))}</Kpi>
          </>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <Legend items={[{ color: C.base, label: frame.baseLegend }, { color: C.primary, label: frame.curLegend }]} />
        <div className="flex flex-wrap items-center gap-2">
          {sel != null && <Unpin onClick={unpin} />}
          {toggle}
        </div>
      </div>
      <div className="mt-3">
        <Plot max={max * (lines ? 1.2 : frame.small === false ? 1.1 : frame.small === true ? 1.15 : 1.22)} yLabel={yLabel} xTitle={frame.xTitle} active={active}
          colMin={frame.colMin} labels={lines ? frame.labels.map(l => ({ ...l, caps: undefined })) : frame.labels}>
          {h => lines ? (
            <>
              {/* под линиями — полоса подсвеченного дня; поверх всего — прозрачные столбцы, которые ловят мышь */}
              <div className="absolute inset-0 flex" aria-hidden>
                {frame.labels.map((l, i) => <div key={l.key} className="h-full min-w-0 flex-1" style={{ borderRadius: 6, background: active === i ? C.mutedBg : undefined, boxShadow: pin === i ? `inset 0 0 0 2px ${C.primary}` : undefined, transition: 'background-color .12s' }} />)}
              </div>
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                {segments(shown, h).map((pts, k) => <polyline key={`b${k}`} points={pts} fill="none" style={{ stroke: C.base }} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
                {segments(cur, h).map((pts, k) => <polyline key={`c${k}`} points={pts} fill="none" style={{ stroke: C.primary }} strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
              </svg>
              {frame.labels.map((l, i) => {
                const c = cur[i], b = shown[i];
                if (c == null && b == null) return null;
                const nt = note(i);
                const cTop = c != null && (b == null || c >= b);
                const hi = (cTop ? c : b) as number;
                const low = cTop ? b : c;
                const at = (v: number) => `${h(Math.min(v, max)) * 100}%`;
                const big = active === i;
                // 30 точек с числами сливаются: на длинном периоде числа — только у последней точки
                const numbers = n <= 16 || i === n - 1;
                const label = (v: number, blue: boolean, above: boolean) => (
                  <span className="absolute whitespace-nowrap font-bold leading-none tabular-nums"
                    style={{ left: `${x(i)}%`, bottom: at(v), fontSize: fs, color: blue ? C.primary : C.muted, transform: `translate(-50%, ${above ? '-9px' : 'calc(100% + 9px)'})` }}>{text(v)}</span>
                );
                // число нижней точки стоит под ней; у самой оси — над ней, а если и там тесно — его нет (есть в подсказке)
                const lowPx = low != null ? h(Math.min(low, max)) * CHART_H : 0;
                const gapPx = low != null ? h(Math.min(hi, max)) * CHART_H - lowPx : 0;
                const lowWhere = low == null ? null : lowPx >= fs + 12 ? 'below' : gapPx > 2 * fs + 22 ? 'above' : null;
                return (
                  <div key={l.key}>
                    {b != null && <span className="absolute -translate-x-1/2 translate-y-1/2 rounded-full" style={{ left: `${x(i)}%`, bottom: at(b), width: big ? 10 : 7, height: big ? 10 : 7, background: C.base }} />}
                    {c != null && <span className="absolute -translate-x-1/2 translate-y-1/2 rounded-full" style={{ left: `${x(i)}%`, bottom: at(c), width: big ? 13 : 9, height: big ? 13 : 9, background: C.primary }} />}
                    {numbers && label(hi, cTop, true)}
                    {numbers && low != null && lowWhere && label(low, !cTop, lowWhere === 'above')}
                    {nt && (
                      <span className={`absolute -translate-x-1/2 whitespace-nowrap rounded-md py-0.5 font-bold leading-none tabular-nums ${frame.small === false ? 'px-1.5 text-[13px]' : frame.small === true ? 'px-0.5 text-[10px]' : 'px-1 text-[11px]'}`}
                        style={{ left: `${x(i)}%`, bottom: `calc(${at(hi)} + ${numbers ? fs + 16 : 10}px)`, color: nt.color, background: C.mutedBg }}>{nt.text}</span>
                    )}
                  </div>
                );
              })}
              <div className="absolute inset-0 flex">
                {frame.labels.map((l, i) => <div key={l.key} className="h-full min-w-0 flex-1 cursor-pointer" {...col(i, tipOf(i))} />)}
              </div>
            </>
          ) : (
            <div className="flex h-full items-end">
              {frame.labels.map((l, i) => {
                const nt = note(i);
                const c = cur[i], b = shown[i];
                const top = Math.min(max, Math.max(c ?? 0, b ?? 0));
                const longest = Math.max(c != null ? text(c).length : 0, b != null ? text(b).length : 0);
                return (
                  <div key={l.key} className="relative flex h-full min-w-0 flex-1 items-end justify-center gap-[6%]" style={look(i)} {...col(i, tipOf(i))}>
                    {nt && (
                      <span className={`absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md py-0.5 font-bold leading-none tabular-nums ${pillPos}`}
                        style={{ '--pb': `${h(top) * 100}%`, '--lv': `${10 + longest * 6.5}px`, color: nt.color, background: active === i ? C.surface : C.mutedBg } as CSSProperties}>{nt.text}</span>
                    )}
                    <PairBar value={b != null ? Math.min(b, max) : null} h={h} color={C.base} small={frame.small} label={b != null ? text(b) : undefined}
                      solid={partialMode === 'solid' && i === pi && !over(b) ? basePartial : null} title="" />
                    <PairBar value={c != null ? Math.min(c, max) : null} h={h} color={C.primary} small={frame.small} label={c != null ? text(c) : undefined} title="" />
                  </div>
                );
              })}
            </div>
          )}
        </Plot>
      </div>
      <div className="mt-3 text-[12px] leading-snug" style={{ color: C.muted }}>
        {footer}{clipped && ' Столбец со стрелкой ↑ в разы выше остальных и в шкалу не помещается: он обрезан по верху, число над ним настоящее.'}
      </div>
    </div>
  );
}

const ratio = (num: number | null, den: number | null) => (num != null && den != null && den > 0 ? (num / den) * 100 : null);
const fmtPct = (v: number, short: boolean) => (short ? `${Math.round(v)}%` : `${nf1.format(v)}%`);
/** Сумма в миллионах: до 100 млн — с одним знаком после запятой, дальше целыми. */
const fmtMln = (v: number) => (Math.abs(v) >= 100 ? nf.format(Math.round(v)) : nf1.format(v));

// ───────────────────────── «По дням / Накопительно» ─────────────────────────
// Правка владельца 10.10: «на графиках переключать накоплением или по дням, где это уместно».
// Переключатель стоит у сделок, суммы продаж и трёх конверсий (у конверсии накопительно — это
// конверсия с начала периода по этот день: брони с начала периода ÷ сделки с начала периода).
// У «Сделок по филиалам» его нет: там три филиала столбцами рядом, накопление в таком виде не
// читается. Накопительный вид рисуется линиями (как «Сделки с начала месяца»), у идущего дня
// база — на то же время. Итоги сверху от переключателя не меняются.

/** Сумма с начала периода к каждому столбцу; null (столбца нет) — null. */
const accumulate = (vals: (number | null)[]): (number | null)[] => { let a = 0; return vals.map(v => (v == null ? null : (a += v))); };

/** Накопленные значения с базой «на то же время» у идущего столбца. */
function accumBuckets(b: Buckets): Buckets {
  const base = accumulate(b.base);
  const basePartial = b.pi != null && b.basePartial != null ? (b.pi > 0 ? base[b.pi - 1] ?? 0 : 0) + b.basePartial : null;
  return { ...b, cur: accumulate(b.cur), base, basePartial };
}

/** Состояние и вид переключателя одной карточки. */
function useAccum(frame: Frame, accLabel = 'Накопительно') {
  const [acc, setAcc] = useState(false);
  const year = frame.per === 'в месяц';
  const toggle = (
    <Seg label="Как показать" tone="neutral" value={acc ? 'acc' : 'per'} onPick={k => setAcc(k === 'acc')}
      options={[{ key: 'per', label: year ? 'По месяцам' : 'По дням' }, { key: 'acc', label: accLabel }]} />
  );
  const from = frame.scope.startsWith('year') ? 'года' : frame.scope.startsWith('month') ? 'месяца' : 'недели';
  return {
    acc, toggle,
    /** «в день» / «с начала недели» — в подпись оси. */
    per: acc ? `с начала ${from}` : frame.per,
    note: acc ? ` Накопительно: каждая точка — сколько набрано с начала ${from} по этот ${year ? 'месяц' : 'день'}; синяя линия выше серой — период идёт с опережением.` : '',
  };
}

/** Сделки по столбцам периода в сравнении с прошлым периодом — главный график блока «Сделки».
 *  Неделя — день ко дню с прошлой неделей; месяц — с тем же днём недели четырьмя неделями раньше;
 *  год — месяц к тому же месяцу прошлого года (см. шапку engine/period.ts). До 09.10 это были три
 *  отдельные карточки (WeekCompare, MonthDaily, YearCompare) — сведены в одну на общей PairCard,
 *  чтобы подсветка, подсказки и выбор дня работали одинаково на всех графиках. */
function DealsCard({ resp, cmp, tags, nodeTitle, frame, b: raw }: { resp: DashPeriodResponse; cmp: DashCompare; tags: FilterTag[]; nodeTitle: string; frame: Frame; b: Buckets }) {
  const ac = useAccum(frame);
  const b = ac.acc ? accumBuckets(raw) : raw;
  const going = resp.offset === 0;
  const word = cmp.mode === 'week' ? ['прошлой неделей', 'предыдущей неделей'] : cmp.mode === 'month' ? ['прошлым месяцем', 'предыдущим месяцем'] : ['прошлым годом', 'предыдущим годом'];
  const year = cmp.mode === 'year';
  const how = cmp.mode === 'week'
    ? 'Серый столбец — тот же день прошлой недели, синий — этой. Итог сверху считается день ко дню: только по дням, которые уже наступили. Проценты над столбцами — изменение к тому же дню прошлой недели.'
    : cmp.mode === 'month'
      ? `Серый столбец — тот же день недели четырьмя неделями раньше, синий — ${MONTHS_NOM[Number(resp.from.slice(5, 7)) - 1].toLowerCase()}. Так будни сравниваются с буднями, выходные — с выходными. Итог сверху — день ко дню. Проценты над столбцами — изменение к этому дню.`
      : `Серый столбец — тот же месяц ${cmp.baseYear} года, синий — ${resp.from.slice(0, 4)}. Итог сверху считается по одинаковым датам. Проценты над столбцами — изменение к тому же месяцу ${cmp.baseYear} года.`;
  return (
    <PairCard title={`Сделки в сравнении с ${word[going ? 0 : 1]}`} tags={tags} frame={frame} delta="pct" partialMode={ac.acc ? 'replace' : 'solid'} lines={ac.acc} accum={ac.acc} toggle={ac.toggle}
      sub={`${nodeTitle} · ${frame.sub} · ${ac.acc ? 'сколько сделок набрано с начала периода' : `сколько сделок создано ${year ? 'в каждом месяце' : 'в каждый день'}`}`}
      cur={b.cur} base={b.base} pi={b.pi} basePartial={b.basePartial}
      yLabel={`Сделок ${ac.per}`} fmt={v => nf.format(Math.round(v))}
      totals={{ cur: raw.curTotal, base: raw.baseTotal }} fmtKpi={v => nf.format(Math.round(v))}
      deltaKpi={(c, base) => <Delta cur={c} base={base} />}
      footer={<>{ac.acc ? '' : how} {frame.partialNote}{!ac.acc && b.pi != null && b.basePartial != null && b.base[b.pi] != null && ` Плотная часть серого столбца — создано к тому же моменту: ${nf.format(b.basePartial)} из ${nf.format(b.base[b.pi]!)}.`}{ac.note}</>} />
  );
}

/** Конверсия num → den по столбцам периода: «на 100 den пришлось столько-то num». */
function RatioCard({ title, tags, nodeTitle, frame, num: rawNum, den: rawDen, numWord, denWord, what, formula }: {
  title: string; tags: FilterTag[]; nodeTitle: string; frame: Frame; num: Buckets; den: Buckets;
  /** «броней», «продаж» / «сделок», «броней» — для строк «броней: 243 · сделок: 889». */
  numWord: string; denWord: string;
  /** Что показывает точка — в подзаголовок. */
  what: string;
  /** Как считается — в сноску под графиком. */
  formula: string;
}) {
  // у конверсии кнопка — «С начала периода», а не «Накопительно»: конверсии не складываются, копятся
  // числитель и знаменатель (владелец 10.10: «а разве конверсия может быть накопительной?»)
  const ac = useAccum(frame, 'С начала периода');
  // накопительно: конверсия с начала периода — числитель и знаменатель копятся отдельно
  const nm = ac.acc ? accumBuckets(rawNum) : rawNum, dn = ac.acc ? accumBuckets(rawDen) : rawDen;
  const num = nm, den = dn;
  const cur = num.cur.map((v, i) => ratio(v, den.cur[i]));
  const base = num.base.map((v, i) => ratio(v, den.base[i]));
  const parts = (n: number | null, d: number | null) => (n != null && d != null ? `${numWord}: ${nf.format(n)} · ${denWord}: ${nf.format(d)}` : null);
  return (
    <PairCard title={title} tags={tags} frame={frame} delta="pp" partialMode="replace" lines accum={ac.acc} toggle={ac.toggle}
      sub={`${nodeTitle} · ${frame.sub} · ${ac.acc ? `${what}, с начала периода` : what}`}
      cur={cur} base={base} pi={num.pi} basePartial={ratio(num.basePartial, den.basePartial)}
      yLabel={`Конверсия ${ac.per}, %`} fmt={fmtPct}
      totals={{ cur: ratio(rawNum.curTotal, rawDen.curTotal), base: ratio(rawNum.baseTotal, rawDen.baseTotal), curSub: parts(rawNum.curTotal, rawDen.curTotal), baseSub: parts(rawNum.baseTotal, rawDen.baseTotal) }}
      fmtKpi={v => `${nf1.format(v)}%`} deltaKpi={(c, b) => <DeltaPP cur={c} base={b} />}
      subOf={i => ({
        cur: parts(num.cur[i], den.cur[i]),
        base: i === num.pi && num.basePartial != null ? parts(num.basePartial, den.basePartial) : parts(num.base[i], den.base[i]),
      })}
      footer={<>Синяя линия выше серой — конверсия выросла, ниже — упала. {formula} Число в плашке над точками — на сколько процентных пунктов конверсия выше или ниже. {frame.partialNote}{ac.acc && ' С начала периода: каждая точка — конверсия за всё время с начала периода по этот день (брони и сделки с начала периода), а не только за этот день; последняя точка — итог сверху.'}</>} />
  );
}

/** Сумма продаж по столбцам периода, в миллионах рублей. */
function AmountCard({ title, tags, nodeTitle, frame, b: raw, ship }: { title: string; tags: FilterTag[]; nodeTitle: string; frame: Frame; b: Buckets; /** сумма отгрузок, а не продаж */ ship?: boolean }) {
  const ac = useAccum(frame);
  const done = ship ? 'отгружено' : 'продано';
  const what = ship ? 'Сумма отгрузок' : 'Сумма продаж';
  const b = ac.acc ? accumBuckets(raw) : raw;
  const mln = (v: number | null) => (v == null ? null : v / 1e6);
  return (
    <PairCard title={title} tags={tags} frame={frame} delta="pct" partialMode={ac.acc ? 'replace' : 'solid'} lines={ac.acc} accum={ac.acc} toggle={ac.toggle}
      sub={`${nodeTitle} · ${frame.sub} · ${ac.acc ? `на какую сумму ${done} с начала периода` : `на какую сумму ${done} ${frame.per}`}`}
      cur={b.cur.map(mln)} base={b.base.map(mln)} pi={b.pi} basePartial={mln(b.basePartial)}
      yLabel={`${what} ${ac.per}, млн ₽`} fmt={v => fmtMln(v)}
      totals={{ cur: raw.curTotal / 1e6, base: raw.baseTotal / 1e6 }} fmtKpi={v => `${fmtMln(v)} млн ₽`}
      deltaKpi={(c, base) => <Delta cur={c} base={base} unit="млн ₽" />}
      footer={<>{ship
        ? `Сумма всех отгрузок за ${frame.per === 'в месяц' ? 'месяц' : 'день'} по дате отгрузки — первичных и повторных.`
        : `Сумма всех продаж за ${frame.per === 'в месяц' ? 'месяц' : 'день'} по дате продажи — первичных и повторных, та же сумма, что «Продажи» на вкладке «Сегодня».`} Проценты над столбцами — изменение суммы. {frame.partialNote}{!ac.acc && b.pi != null && b.basePartial != null && ` Плотная часть серого столбца — ${done} к тому же моменту.`}{ac.note}</>} />
  );
}

/** Заголовок блока страницы: о чём графики ниже (правка владельца 09.10 — блоки «Сделки»,
 *  «Брони», «Продажи» отделены друг от друга и подписаны). */
function SectionHead({ title, note, controls }: { title: string; note: string; /** свои фильтры блока — строкой под линией заголовка */ controls?: ReactNode }) {
  return (
    // Фильтры блока — под линией заголовка, у левого края (владелец 09.10). До этого побывали у
    // правого края строки заголовка и слева перед названием — оба места владельцу не понравились.
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 pb-2" style={{ borderBottom: `2px solid ${C.primary}` }}>
        <h2 className="text-[26px] font-bold leading-tight">{title}</h2>
        <span className="text-[13px] font-medium" style={{ color: C.muted }}>{note}</span>
      </div>
      {controls && <div className="mt-3">{controls}</div>}
    </div>
  );
}

/** Идущий период без столбцов, которые ещё не наступили. ПРАВИЛО ВЛАДЕЛЬЦА (09.10: «убери из
 *  графиков дни, которые ещё не наступили, очень раздражают»): на графиках текущей недели,
 *  месяца и года нет будущих дней / месяцев — ни пустых мест под них, ни серых столбцов и линии
 *  прошлого периода за эти дни. Неделя в пятницу — это пн…пт, октябрь 9-го — числа 1…9, год в
 *  октябре — янв…окт. Итоги сверху от этого не меняются (они и раньше считались день ко дню).
 *  У прошедших периодов обрезать нечего. */
function trimFuture(resp: DashPeriodResponse): DashPeriodResponse {
  if (resp.offset !== 0) return resp;
  const lim = resp.period === 'year' ? resp.today.slice(0, 7) : resp.today;
  const n = resp.buckets.filter(b => b <= lim).length;
  if (n === 0 || n >= resp.buckets.length) return resp;
  const cut = (c: DashCompare | null): DashCompare | null => {
    if (!c) return c;
    if (c.mode === 'week') return { ...c, series: c.series.map(s => ({ ...s, cur: s.cur.slice(0, n), base: s.base.slice(0, n) })) };
    if (c.mode === 'month') return { ...c, curDays: n, baseDays: n, baseTo: addDays(c.baseFrom, n - 1), series: c.series.map(s => ({ ...s, cur: s.cur.slice(0, n), base: s.base.slice(0, n) })) };
    return { ...c, series: c.series.map(s => ({ ...s, cur: s.cur.slice(0, n), base: s.base.slice(0, n) })) };
  };
  return {
    ...resp,
    buckets: resp.buckets.slice(0, n),
    series: resp.series.map(s => ({ ...s, values: s.values.slice(0, n) })),
    compare: cut(resp.compare),
    extra: resp.extra
      ? Object.fromEntries(Object.entries(resp.extra).map(([k, c]) => [k, cut(c)])) as DashPeriodResponse['extra']
      : resp.extra,
  };
}

// ───────────────────────── у каждого блока — свои фильтры ─────────────────────────
// Правки владельца 09.10. Сначала: «на каждый график отдельно добавим фильтр неделя / месяц /
// год, а также филиал и департамент» — переключатели стояли в заголовке каждой карточки. Через
// несколько минут: «давай выведем это на общий блок, а не отдельный график» — теперь три
// переключателя стоят в заголовке БЛОКА («Сделки», «Брони», «Продажи») и действуют на оба его
// графика. Фильтры страницы (вкладки периода, «Филиал», «Департамент», выбор даты) задают
// значение для ВСЕХ блоков. Свой фильтр блока живёт, пока тот же фильтр страницы не поменяли:
// поменяли на странице — все блоки снова показывают выбранное на странице.

/** Оргструктура для фильтров: филиалы и их департаменты (страница собирает из дерева «Сегодня»). */
export interface ScopeCity { id: string; name: string; short: string; depts: { id: string; name: string; label: string }[] }
export interface ScopeTree { rootId: string; cities: ScopeCity[] }
export interface ScopeSel { cityId: string | null; dept: string | null }

/** ПРАВИЛО ВЛАДЕЛЬЦА (09.10) про ЖБИ. Департамент ЖБИ есть только в Москве, поэтому:
 *    • кнопка «ЖБИ» в фильтре «Департамент» видна, только когда в фильтре «Филиал» выбрана
 *      Москва (при «Все», СПБ, КРД — только «Все / НЦ / ОС»);
 *    • филиал не выбран («Все») и выбран НЦ — ЖБИ ВХОДИТ в НЦ (НЦ всех филиалов + московский ЖБИ);
 *    • выбрана Москва и НЦ — московский НЦ БЕЗ ЖБИ (ЖБИ рядом отдельной кнопкой; НЦ + ЖБИ + ОС
 *      в сумме дают весь филиал).
 *  Ключ — департамент, который без выбранного филиала прячется, значение — в какой он входит. */
const DEPT_FOLD: Record<string, string> = { 'ЖБИ': 'НЦ' };

/** Пункты фильтра «Департамент» при выбранном филиале (null — «Все»). */
export function scopeDeptLabels(tree: ScopeTree, cityId: string | null): string[] {
  const city = tree.cities.find(c => c.id === cityId) ?? null;
  const labels = city ? city.depts.map(d => d.label) : tree.cities.flatMap(c => c.depts.map(d => DEPT_FOLD[d.label] ?? d.label));
  return [...new Set(labels)].sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Срез по выбранным филиалу и департаменту: чьи сделки складывать, как это назвать, кого сравнивать
 *  между собой в карточке «по филиалам / департаментам». */
function resolveScope(tree: ScopeTree, sel: ScopeSel) {
  const city = tree.cities.find(c => c.id === sel.cityId) ?? null;
  const pool = city ? [city] : tree.cities;
  const deptLabels = scopeDeptLabels(tree, city?.id ?? null);
  const dept = sel.dept && deptLabels.includes(sel.dept) ? sel.dept : null;
  // без выбранного филиала в департамент входят и «сложенные» в него (ЖБИ → НЦ)
  const inDept = (label: string) => label === dept || (!city && DEPT_FOLD[label] === dept);
  const blocks = dept ? pool.map(c => ({ city: c, depts: c.depts.filter(d => inDept(d.label)) })).filter(b => b.depts.length > 0) : [];
  const title = dept ? `${dept} · ${city ? city.name : 'все филиалы'}` : city ? city.name : 'Все филиалы';
  const ids = dept ? blocks.flatMap(b => b.depts.map(d => d.id)) : [city?.id ?? tree.rootId];
  const rows: PeriodRow[] = dept
    ? (city ? [] : blocks.map(b => ({ key: b.city.id, name: b.city.name, short: b.city.short, ids: b.depts.map(d => d.id) })))
    : city
      ? city.depts.map(d => ({ key: d.id, name: d.name, short: d.label, ids: [d.id] }))
      : tree.cities.map(c => ({ key: c.id, name: c.name, short: c.short, ids: [c.id] }));
  const rowsTitle = !dept && city ? 'Сделки по департаментам' : 'Сделки по филиалам';
  // выбранные фильтры — плашками в заголовке графика (цвета те же, что у фильтров)
  const tags: FilterTag[] = [
    ...(city ? [{ label: city.short, tone: 'primary' as const }] : []),
    ...(dept ? [{ label: dept, tone: 'accent' as const }] : []),
  ];
  return { city, dept, deptLabels, title, ids, rows, rowsTitle, tags };
}

/** Маленький переключатель в заголовке блока. Цвета — как у фильтров страницы: филиал синий,
 *  департамент жёлтый; период — тёмный. */
function Seg({ label, tone, options, value, onPick }: {
  label: string; tone: 'neutral' | 'primary' | 'accent';
  options: { key: string; label: string }[]; value: string; onPick: (key: string) => void;
}) {
  // выбранный пункт — бледной заливкой своего цвета (владелец 09.10: «сделай более блёклыми»; сначала
  // были плотные чёрный / синий / жёлтый, как у фильтров страницы, и спорили с ними за внимание)
  const tint = (color: string, share: number) => `color-mix(in srgb, ${color} ${share}%, transparent)`;
  const on = tone === 'accent' ? { background: tint(C.accent, 45), color: C.text } : tone === 'primary' ? { background: tint(C.primary, 16), color: C.primary } : { background: tint(C.text, 12), color: C.text };
  return (
    <div role="tablist" aria-label={label} title={label} className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg p-0.5" style={{ background: C.surface }}>
      {options.map(o => (
        <button key={o.key} type="button" role="tab" aria-selected={o.key === value} onClick={() => onPick(o.key)}
          className="min-h-[30px] cursor-pointer rounded-md px-2.5 text-[12px] font-bold leading-none transition-colors"
          style={o.key === value ? on : { background: 'transparent', color: C.muted }}>{o.label}</button>
      ))}
    </div>
  );
}

/** Карточка без графика: идёт загрузка, нет данных для сравнения и т. п. */
function Stub({ title, tags, text, error }: { title: string; tags: FilterTag[]; text: string; error?: boolean }) {
  return (
    <div className="min-w-0 p-4 sm:p-5" style={card}>
      <CardTitle tags={tags}>{title}</CardTitle>
      <div className="mt-3 text-[13px] font-medium" style={{ color: error ? C.error : C.muted }}>{text}</div>
    </div>
  );
}

/** Простой график без сравнения — когда за предыдущий период данных в базе нет. */
function PlainCard({ resp, nodeId, nodeTitle, tags }: { resp: DashPeriodResponse; nodeId: string; nodeTitle: string; tags: FilterTag[] }) {
  const series = resp.series.find(x => x.id === nodeId);
  const year = resp.period === 'year';
  return (
    <div className="min-w-0 p-4 sm:p-5" style={card}>
      <CardTitle tags={tags}>{year ? 'Сделки по месяцам' : 'Сделки по дням'}</CardTitle>
      <div className="mt-0.5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="text-[13px] font-medium" style={{ color: C.muted }}>{nodeTitle} · сколько сделок создано {year ? 'в каждом месяце' : 'в каждый день'} · {resp.label}</div>
        <div className="text-right">
          <div className="text-[13px] font-medium" style={{ color: C.muted }}>Всего сделок</div>
          <div className="text-[28px] font-bold leading-tight tabular-nums" style={{ color: C.primary }}>{nf.format(series?.total ?? 0)}</div>
        </div>
      </div>
      <div className="mt-4">
        <CreatedChart resp={resp} values={series?.values ?? []} />
      </div>
      <div className="mt-3 text-[12px] leading-snug" style={{ color: C.muted }}>
        Сравнивать не с чем: за предыдущий период данных в базе нет.
        {resp.offset === 0 && (year ? ' Светлый столбец — текущий месяц, он ещё не закончился.' : ' Светлый столбец — сегодня, день ещё не закончился.')}
      </div>
    </div>
  );
}

type SlotKind = 'deals' | 'cumulative' | 'rows' | 'dealToResv' | 'resvToSale' | 'dealToSale' | 'amount' | 'dealToShip' | 'saleToShip' | 'shipAmount';
/** Название карточки, пока её данные грузятся или графика нет. */
const SLOT_TITLE: Record<SlotKind, string> = {
  deals: 'Сделки в сравнении с прошлым периодом',
  cumulative: 'Сделки с начала месяца, накопительно',
  rows: 'Сделки по филиалам',
  dealToResv: 'Конверсия из сделки в бронь',
  resvToSale: 'Конверсия из брони в продажу',
  dealToSale: 'Конверсия из сделки в продажу',
  amount: 'Сумма продаж',
  dealToShip: 'Конверсия из сделки в отгрузку',
  saleToShip: 'Конверсия из продажи в отгрузку',
  shipAmount: 'Сумма отгрузок',
};
const PERIOD_OPTS: { key: DashPeriod; label: string }[] = [{ key: 'week', label: 'Неделя' }, { key: 'month', label: 'Месяц' }, { key: 'year', label: 'Год' }];

/** Одно место графика в блоке: свой запрос данных (одинаковые периоды у разных графиков — один
 *  запрос, его делит кэш) и нужная карточка внутри. Период, филиал и департамент задаёт блок. */
function ChartSlot({ kind, period, offset, tree, sel, onFilter }: {
  kind: SlotKind; period: DashPeriod; offset: number; tree: ScopeTree; sel: ScopeSel; onFilter?: OnFilter;
}) {
  const sc = resolveScope(tree, sel);
  const q = useDashPeriod(period, offset);
  const raw = q.data && q.data.period === period ? q.data : null;

  let body: ReactNode;
  if (!raw) {
    body = <Stub title={kind === 'rows' ? sc.rowsTitle : SLOT_TITLE[kind]} tags={sc.tags} error={q.isError} text={q.isError ? 'Не удалось загрузить данные. Обновите страницу.' : 'Считаем…'} />;
  } else {
    const SCOPE = 'grp:scope';
    const resp = trimFuture(withGroups(raw, [{ key: SCOPE, name: sc.title, ids: sc.ids }, ...sc.rows.map(r => ({ key: `grp:${r.key}`, name: r.name, ids: r.ids }))]));
    const cmp = resp.compare;
    const p = { resp, nodeId: SCOPE, nodeTitle: sc.title, tags: sc.tags };
    const none = <Stub title={SLOT_TITLE[kind]} tags={sc.tags} text="Сравнивать не с чем: за предыдущий период данных в базе нет." />;
    if (kind === 'rows') {
      body = sc.rows.length < 2
        ? <Stub title={sc.rowsTitle} tags={sc.tags} text="Сравнивать некого: выбраны и филиал, и департамент. Поставьте в одном из фильтров «Все»." />
        : <BranchCompare resp={resp} title={sc.rowsTitle} scopeId={SCOPE} tags={sc.tags} branches={sc.rows.map(r => ({ id: `grp:${r.key}`, name: r.name, short: r.short }))}
            // нажали на плитку: строки-департаменты (выбран филиал) → фильтр «Департамент» этого филиала; строки-филиалы → фильтр «Филиал»
            onPick={onFilter ? b => {
              const row = sc.rows.find(r => `grp:${r.key}` === b.id);
              if (!row) return;
              if (sc.city && !sc.dept) onFilter(sc.city.id, row.short); else onFilter(row.key, sc.dept);
            } : undefined} />;
    } else if (kind === 'deals') {
      const b = bucketsOf(resp, cmp, SCOPE);
      body = !cmp || !b ? <PlainCard {...p} /> : <DealsCard resp={resp} cmp={cmp} tags={sc.tags} nodeTitle={sc.title} frame={frameOf(resp, cmp)} b={b} />;
    } else if (kind === 'cumulative') {
      body = cmp?.mode === 'month' ? <MonthCompare {...p} cmp={cmp} /> : none;
    } else {
      const frame = cmp ? frameOf(resp, cmp) : null;
      const deals = bucketsOf(resp, cmp, SCOPE);
      const resv = bucketsOf(resp, resp.extra?.reservations, SCOPE);
      const sales = bucketsOf(resp, resp.extra?.sales, SCOPE);
      const salesResv = bucketsOf(resp, resp.extra?.salesReserved, SCOPE);
      const amount = bucketsOf(resp, resp.extra?.salesAmount, SCOPE);
      const ship = bucketsOf(resp, resp.extra?.shipments, SCOPE);
      const shipSold = bucketsOf(resp, resp.extra?.shipmentsSold, SCOPE);
      const shipAmount = bucketsOf(resp, resp.extra?.shipmentsAmount, SCOPE);
      const unit = frame?.per === 'в месяц' ? 'месяц' : 'день';
      const r = { tags: sc.tags, nodeTitle: sc.title };
      if (!frame) body = none;
      else if (kind === 'dealToResv' && resv && deals) {
        body = <RatioCard title={SLOT_TITLE[kind]} {...r} frame={frame} num={resv} den={deals} numWord="броней" denWord="сделок" what="сколько броней на 100 созданных сделок"
          formula={`Конверсия за ${unit} — первичные брони, поставленные за это время, делённые на первичные сделки, созданные за это же время (в отчётах — «CR Сделка → Бронь (перв.)»).`} />;
      } else if (kind === 'resvToSale' && salesResv && resv) {
        // в числителе только продажи, прошедшие через бронь (решение владельца 09.10)
        body = <RatioCard title={SLOT_TITLE[kind]} {...r} frame={frame} num={salesResv} den={resv} numWord="продаж из брони" denWord="броней" what="сколько продаж из брони на 100 броней"
          formula={`Конверсия за ${unit} — первичные продажи за это время, у которых была бронь, делённые на первичные брони за это же время. Продажи, прошедшие мимо брони, не считаются.`} />;
      } else if (kind === 'dealToSale' && sales && deals) {
        body = <RatioCard title={SLOT_TITLE[kind]} {...r} frame={frame} num={sales} den={deals} numWord="продаж" denWord="сделок" what="сколько продаж на 100 созданных сделок"
          formula={`Конверсия за ${unit} — первичные продажи за это время, делённые на первичные сделки, созданные за это же время (в отчётах — «CR Сделка → Продажа (перв.)»).`} />;
      } else if (kind === 'amount' && amount) {
        body = <AmountCard title={SLOT_TITLE[kind]} {...r} frame={frame} b={amount} />;
      } else if (kind === 'dealToShip' && ship && deals) {
        body = <RatioCard title={SLOT_TITLE[kind]} {...r} frame={frame} num={ship} den={deals} numWord="отгрузок" denWord="сделок" what="сколько отгрузок на 100 созданных сделок"
          formula={`Конверсия за ${unit} — первичные отгрузки за это время, делённые на первичные сделки, созданные за это же время (в отчётах — «CR Сделка → Отгрузка (перв.)»).`} />;
      } else if (kind === 'saleToShip' && shipSold && sales) {
        // в числителе только отгрузки, у которых была продажа (по правилу владельца для «бронь → продажа»)
        body = <RatioCard title={SLOT_TITLE[kind]} {...r} frame={frame} num={shipSold} den={sales} numWord="отгрузок после продажи" denWord="продаж" what="сколько отгрузок после продажи на 100 продаж"
          formula={`Конверсия за ${unit} — первичные отгрузки за это время, у которых была продажа, делённые на первичные продажи за это же время. Отгрузки без продажи не считаются.`} />;
      } else if (kind === 'shipAmount' && shipAmount) {
        body = <AmountCard title={SLOT_TITLE[kind]} {...r} frame={frame} b={shipAmount} ship />;
      } else body = none;
    }
  }
  return <>{body}</>;
}

/** Свой фильтр блока: действует, пока фильтр страницы, поверх которого он выбран (over), не изменился. */
interface Own<T> { over: string; value: T }
/** Включить фильтры страницы «Филиал» и «Департамент» (по нажатию на плитку в графике). */
type OnFilter = (cityId: string | null, dept: string | null) => void;

// ЖЁСТКОЕ ПРАВИЛО ВЛАДЕЛЬЦА (09.10, «намертво»): ГРАФИКИ ВСЕГДА ПО ДВА В РЯД — в неделе, в
// месяце и в году, в каждом блоке. Ни одной карточке нельзя ставить col-span-full «потому
// что график широкий»: дважды так делалось (месяц, потом год) и оба раза владелец велел
// вернуть. Не помещается график в половину ряда — он прокручивается внутри своей карточки
// (Plot: overflow-x-auto), сетка при этом не меняется. Карточка без пары (нечётная
// последняя) остаётся в ряду одна и занимает его целиком. Единственное исключение — узкий
// экран: когда место под графики уже 1300px (экран примерно до 1650px, телефон), идёт
// один столбец — в две колонки там не помещается даже неделя.
const GRID = 'grid grid-cols-1 gap-5 @[1300px]:grid-cols-2 [&>*:last-child:nth-child(odd)]:col-span-full';

/** Блок страницы: заголовок, в нём свои фильтры блока (период, филиал, департамент), ниже — графики. */
function Block({ title, note, kinds, period: pagePeriod, offset: pageOffset, tree, sel, onFilter, onChanged }: {
  title: string; note: string;
  /** Какие графики в блоке при его периоде. */
  kinds: (period: DashPeriod) => SlotKind[];
  period: DashPeriod; offset: number; tree: ScopeTree; sel: ScopeSel; onFilter?: OnFilter;
  /** Блок сообщает, настроен ли он не как страница (для «Сбросить все фильтры»). */
  onChanged?: (title: string, changed: boolean) => void;
}) {
  const [ownPeriod, setOwnPeriod] = useState<Own<DashPeriod> | null>(null);
  const [ownCity, setOwnCity] = useState<Own<string | null> | null>(null);
  const [ownDept, setOwnDept] = useState<Own<string | null> | null>(null);
  const overP = `${pagePeriod}|${pageOffset}`, overC = String(sel.cityId), overD = String(sel.dept);
  const period: DashPeriod = ownPeriod?.over === overP ? ownPeriod.value : pagePeriod;
  // свой период блока — всегда текущая неделя / месяц / год; выбор даты на странице листает только её период
  const offset = period === pagePeriod ? pageOffset : 0;
  const cityId = ownCity?.over === overC ? ownCity.value : sel.cityId;
  const sc = resolveScope(tree, { cityId, dept: ownDept?.over === overD ? ownDept.value : sel.dept });
  const changed = period !== pagePeriod || cityId !== sel.cityId || sc.dept !== resolveScope(tree, sel).dept;
  useEffect(() => { onChanged?.(title, changed); }, [onChanged, title, changed]);
  const controls = (
    // между группами фильтров 16px (было 6 — владелец 09.10: «сделай отступ между фильтрами больше»)
    <div className="flex max-w-full flex-wrap items-center gap-x-4 gap-y-2">
      <Seg label={`Период блока «${title}»`} tone="neutral" options={PERIOD_OPTS} value={period} onPick={k => setOwnPeriod({ over: overP, value: k as DashPeriod })} />
      <Seg label={`Филиал блока «${title}»`} tone="primary" value={cityId ?? ''} onPick={k => setOwnCity({ over: overC, value: k || null })}
        options={[{ key: '', label: 'Все' }, ...tree.cities.map(c => ({ key: c.id, label: c.short }))]} />
      {sc.deptLabels.length > 0 && (
        <Seg label={`Департамент блока «${title}»`} tone="accent" value={sc.dept ?? ''} onPick={k => setOwnDept({ over: overD, value: k || null })}
          options={[{ key: '', label: 'Все' }, ...sc.deptLabels.map(l => ({ key: l, label: l }))]} />
      )}
      {changed && (
        <button type="button" onClick={() => { setOwnPeriod(null); setOwnCity(null); setOwnDept(null); }} title="Вернуть этому блоку фильтры страницы"
          className="min-h-[30px] cursor-pointer rounded-md px-2 text-[12px] font-bold leading-none underline underline-offset-2" style={{ color: C.muted }}>Сбросить</button>
      )}
    </div>
  );
  return (
    <section className="flex flex-col gap-4">
      <SectionHead title={title} note={note} controls={controls} />
      <div className={GRID}>
        {kinds(period).map(kind => <ChartSlot key={kind} kind={kind} period={period} offset={offset} tree={tree} sel={{ cityId, dept: sc.dept }} onFilter={onFilter} />)}
      </div>
    </section>
  );
}

export function PeriodView({ period, offset, tree, sel, onFilter, resetKey, onOwnFilters }: {
  /** Период и дата, выбранные на странице, — значение по умолчанию для всех блоков. */
  period: DashPeriod; offset: number;
  tree: ScopeTree;
  /** Филиал и департамент, выбранные на странице. */
  sel: ScopeSel;
  /** Нажали на филиал / департамент в графике — страница включает фильтр по нему. */
  onFilter?: OnFilter;
  /** «Сбросить все фильтры» на странице: при смене числа блоки забывают свои фильтры. */
  resetKey?: number;
  /** Есть ли хоть один блок, настроенный не как страница, — чтобы страница показала «Сбросить все фильтры». */
  onOwnFilters?: (any: boolean) => void;
}) {
  const [own, setOwn] = useState<Record<string, boolean>>({});
  const onChanged = useCallback((title: string, changed: boolean) => setOwn(o => (o[title] === changed ? o : { ...o, [title]: changed })), []);
  const anyOwn = Object.values(own).some(Boolean);
  useEffect(() => { onOwnFilters?.(anyOwn); }, [onOwnFilters, anyOwn]);
  const g = { period, offset, tree, sel, onFilter, onChanged };
  // Выбранный день (общий для графиков одного периода) и подсказка у места нажатия — см. «интерактивность графиков».
  const [pin, setPin] = useState<FxAt | null>(null);
  const [tip, setTip] = useState<{ node: ReactNode; x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // подсказка стоит правее и ниже места нажатия и едет вместе со страницей; у края — с другой стороны
  useLayoutEffect(() => {
    const el = tipRef.current, root = rootRef.current;
    if (!el || !root || !tip) return;
    const w = el.offsetWidth, hh = el.offsetHeight;
    const left = tip.x + 16 + w > root.clientWidth ? tip.x - 16 - w : tip.x + 16;
    const top = tip.y + 18 + hh > root.clientHeight ? tip.y - 12 - hh : tip.y + 18;
    el.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
    el.style.visibility = 'visible';
  }, [tip]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPin(null); setTip(null); } };
    // нажали мимо столбцов графиков — подсказка уходит (а при включённом выборе дня он остаётся)
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-fx-col]')) return;
      setTip(null);
      if (!PIN_ON_CLICK) setPin(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, []);
  const fx: Fx = {
    pin,
    click: (scope, i, make, e) => {
      if (pin && pin.scope === scope && pin.i === i) { setPin(null); setTip(null); return; }
      const box = rootRef.current?.getBoundingClientRect();
      setPin({ scope, i });
      setTip({ node: make(), x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
    },
    clear: () => { setPin(null); setTip(null); },
  };
  return (
    <FxCtx.Provider value={fx}>
    <div ref={rootRef} className="relative flex flex-col gap-5">
      {tip && (
        <div ref={tipRef} role="tooltip" className="pointer-events-none absolute left-0 top-0 z-[60] max-w-[320px] rounded-[10px] px-3 py-2.5"
          style={{ visibility: 'hidden', background: C.surface, color: C.text, border: `1px solid ${C.line}`, boxShadow: '0 8px 28px rgba(0,0,0,.22)' }}>{tip.node}</div>
      )}
      {/* Три блока, каждый со своим заголовком (правка владельца 09.10): сделки, брони, продажи. */}
      {/* между блоками 56px (было 40 — владелец 09.10 попросил «чуть больше»); pt-6 — такой же
          воздух между фильтрами и первым блоком (было 16px, стало 40 — «здесь тоже») */}
      <div className="@container flex flex-col gap-14 pt-6">
        {/* накопительный график — только когда у блока выбран месяц */}
        <Block {...g} key={`deals:${resetKey ?? 0}`} title="Сделки" note="Первичные сделки, созданные за период" kinds={p => (p === 'month' ? ['deals', 'cumulative', 'rows'] : ['deals', 'rows'])} />
        <Block {...g} key={`resv:${resetKey ?? 0}`} title="Брони" note="Сколько сделок доходит до брони и сколько броней — до продажи" kinds={() => ['dealToResv', 'resvToSale']} />
        <Block {...g} key={`sales:${resetKey ?? 0}`} title="Продажи" note="Сколько сделок доходит до продажи и на какую сумму продано" kinds={() => ['dealToSale', 'amount']} />
        {/* блок «Отгрузки» (владелец 10.10) */}
        <Block {...g} key={`ship:${resetKey ?? 0}`} title="Отгрузки" note="Сколько сделок и продаж доходит до отгрузки и на какую сумму отгружено" kinds={() => ['dealToShip', 'saleToShip', 'shipAmount']} />
      </div>
      <div className="text-[12px] leading-snug" style={{ color: C.muted }}>
        Сделки, брони, отгрузки и конверсии считаются по первичным сделкам, повторные не входят (сделки — метрика «Кол-во сделок (перв.)»); суммы продаж и отгрузок — все продажи и отгрузки. Город и департамент — по текущему менеджеру сделки. Все периоды — по календарным дням. Переключатели в заголовке блока меняют только графики этого блока; фильтры вверху страницы — все блоки сразу. Нажмите на день на любом графике — появится подсказка с его цифрами (нажать ещё раз, мимо графика или Esc — убрать). Нажатие на плитку филиала или департамента в «Сделки по филиалам» включает фильтр по нему.
      </div>
    </div>
    </FxCtx.Provider>
  );
}
