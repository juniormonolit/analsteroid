'use client';
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { MONTHS } from '../../data';
import type { BlockKind, BlockUnit } from '../../sheets';
import { C } from './theme';

// Общие кирпичи «ССП тест» в стиле макетов monolit.shop (правка владельца 10.10:
// «переделаем визуал под наш дизайн»): карточки, плитки KPI, переключатели,
// вкладки и таблица план/факт — всё по 00-stil.html / 04-prodazhi-po-menedzheram.html.
// Цвета — через C (переменные --dt-*, как у «Дашборда»), чтобы страница выглядела
// как макет в любой теме приложения и переключалась в тёмную вместе с «Дашбордом».

export type ViewMode = 'months' | 'cumulative';
export type MoneyUnit = 'mln' | 'rub';
/** Плотность таблицы: все цифры или только процент по месяцам. */
export type Density = 'full' | 'pct';

export const MONTH_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

export interface CalendarInfo { currentMonth: number; currentMonthWeight: number; workingDays: { total: number; passed: number } }

export interface TableLine {
  key: string;
  label: string;
  level: 'total' | 'group' | 'row';
  planMonths: number[] | null;
  planYear: number | null;
  factMonths: (number | null)[];
  factYtd: number | null;
  planToDate: number | null;
  note?: string;
  /** Строка приглушена (менеджер вне оргструктуры, строка только с фактом). */
  muted?: boolean;
}

// ── Форматирование ───────────────────────────────────────────────────────────
export function fmtVal(v: number | null | undefined, unit: BlockUnit, money: MoneyUnit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'money':
      return money === 'mln'
        ? (v / 1_000_000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : Math.round(v).toLocaleString('ru-RU');
    case 'count': return Math.round(v).toLocaleString('ru-RU');
    case 'count1': return v.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case 'pct': return `${(v * 100).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  }
}

export function fmtDelta(d: number | null, unit: BlockUnit, money: MoneyUnit): string {
  if (d === null || !Number.isFinite(d)) return '—';
  if (unit === 'pct') {
    const pp = d * 100;
    return `${pp > 0 ? '+' : pp < 0 ? '−' : ''}${Math.abs(pp).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} п.п.`;
  }
  const s = fmtVal(Math.abs(d), unit, money);
  return d < 0 ? `−${s}` : d > 0 ? `+${s}` : s;
}

export function fmtPct(fact: number | null, plan: number | null): string {
  if (fact === null || plan === null || plan <= 0) return '—';
  return `${Math.round((fact / plan) * 100)}%`;
}

export function unitLabel(unit: BlockUnit, money: MoneyUnit): string {
  if (unit === 'money') return money === 'mln' ? 'млн ₽' : '₽';
  if (unit === 'pct') return '%';
  return 'шт';
}

// ── Тепловая карта выполнения плана ──────────────────────────────────────────
// Непрерывная шкала: чем дальше от 100%, тем насыщеннее заливка. Ниже плана —
// красный ошибки макета, выше — зелёный успеха, ±3% около 100% — нейтрально.
// Для «меньше — лучше» (отказы, % слёта) шкала перевёрнута.
export function heatRatio(fact: number | null, plan: number | null, lowerIsBetter = false): number | null {
  if (fact === null || plan === null || plan <= 0) return null;
  const r = fact / plan;
  return lowerIsBetter ? (r > 0 ? 1 / r : 2) : r;
}

export function heatStyle(ratio: number | null): CSSProperties | undefined {
  if (ratio === null || !Number.isFinite(ratio)) return undefined;
  const d = ratio - 1;
  if (Math.abs(d) < 0.03) return { background: `color-mix(in srgb, ${C.muted} 12%, transparent)`, color: C.text };
  // −40% от плана = максимум красного, +30% = максимум зелёного.
  const t = d < 0 ? Math.min(1, -d / 0.4) : Math.min(1, d / 0.3);
  const pct = Math.round(10 + t * 34);
  const token = d < 0 ? C.error : C.success;
  return { background: `color-mix(in srgb, ${token} ${pct}%, transparent)`, color: C.text };
}

/** Цвет текста отклонения: зелёный рост, красный падение (как .up/.down макета). */
export function toneColor(d: number | null, lowerIsBetter = false): string {
  if (d === null || d === 0) return C.muted;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return good ? C.successText : C.error;
}
export function ratioColor(fact: number | null, plan: number | null, lowerIsBetter = false): string {
  const r = heatRatio(fact, plan, lowerIsBetter);
  if (r === null) return C.muted;
  return r >= 1 ? C.successText : r >= 0.85 ? C.text : C.error;
}

export function HeatLegend({ lowerIsBetter = false }: { lowerIsBetter?: boolean }) {
  const stops = lowerIsBetter
    ? [{ v: 1.6, l: '160%' }, { v: 1.25, l: '125%' }, { v: 1, l: '100%' }, { v: 0.85, l: '85%' }, { v: 0.7, l: '70%' }]
    : [{ v: 0.6, l: '60%' }, { v: 0.8, l: '80%' }, { v: 1, l: '100%' }, { v: 1.15, l: '115%' }, { v: 1.3, l: '130%' }];
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium" style={{ color: C.muted }}>
      <span>% плана:</span>
      {stops.map(st => (
        <span key={st.l} className="rounded px-1.5 py-0.5 tabular-nums" style={heatStyle(lowerIsBetter ? 1 / st.v : st.v)}>{st.l}</span>
      ))}
      {lowerIsBetter && <span>· меньше — лучше</span>}
    </div>
  );
}

// ── Контейнеры и контролы ────────────────────────────────────────────────────
export const cardStyle: CSSProperties = { background: C.surface, borderRadius: 10 };

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`min-w-0 p-4 sm:p-5 ${className}`} style={cardStyle}>{children}</section>;
}

/** Заголовок карточки: 18/700 + подсказка 13/500 (card-h макета). */
export function CardHead({ title, hint, right }: { title: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="text-[18px] font-bold leading-snug">{title}</h2>
      {hint && <span className="text-[13px] font-medium" style={{ color: C.muted }}>{hint}</span>}
      {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

/** Плитка KPI (.kpi макета): подпись 13/500, число 28/700, строка под ним. */
export function Kpi({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div className="min-w-0 rounded-[10px] px-4 py-3" style={{ background: C.mutedBg }}>
      <div className="truncate text-[13px] font-medium leading-snug" style={{ color: C.muted }}>{label}</div>
      <div className="mt-1 text-[24px] font-bold leading-tight tabular-nums sm:text-[28px]" style={{ color: color ?? C.text }}>{value}</div>
      {sub && <div className="mt-0.5 text-[13px] font-medium leading-snug tabular-nums" style={{ color: C.muted }}>{sub}</div>}
    </div>
  );
}

/** Переключатель (.seg макета): серая подложка, выбранное — синяя плашка, 13/700. */
export function Seg<T extends string>({ value, onChange, options, label, disabled, onSurface, tone = 'primary' }: {
  value: T; onChange: (v: T) => void; options: { v: T; label: string }[]; label?: string; disabled?: boolean;
  /** Переключатель стоит на белой карточке — подложка серая; на фоне страницы — белая. */
  onSurface?: boolean;
  /** Цвет выбранного: синий (по умолчанию) или жёлтый акцент сайта — как фильтр
   *  «Департамент» на «Дашборде», чтобы отделы отличались от городов. */
  tone?: 'primary' | 'accent';
}) {
  return (
    <div className={`inline-flex items-center gap-2 ${disabled ? 'opacity-50' : ''}`}>
      {label && <span className="text-[13px] font-medium" style={{ color: C.muted }}>{label}</span>}
      <div role="tablist" aria-label={label} className="inline-flex max-w-full flex-wrap gap-0.5 rounded-[10px] p-[3px]" style={{ background: onSurface ? C.mutedBg : C.surface }}>
        {options.map(o => {
          const on = value === o.v;
          return (
            <button
              key={o.v}
              type="button"
              role="tab"
              aria-selected={on}
              disabled={disabled}
              onClick={() => onChange(o.v)}
              className="min-h-[34px] cursor-pointer rounded-lg px-3.5 text-[13px] font-bold leading-none transition-colors disabled:cursor-default"
              style={on ? (tone === 'accent' ? { background: C.accent, color: C.onAccent } : { background: C.primary, color: C.onPrimary }) : { background: 'transparent', color: C.text }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Компактный переключатель в прежнем оформлении страницы — на токенах темы приложения,
 *  до перехода на стиль monolit.shop (правка владельца 10.10: «только этот блок — в дизайне,
 *  который был до Куликова»). Используется для «Вид / Цифры / Единицы» в шапке. */
export function CompactSeg<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { v: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5">
      {options.map(o => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          // Выбранное — только обводкой, без заливки (правка владельца 10.10).
          className={`px-3 min-h-9 rounded-md text-xs font-medium transition-colors border ${
            value === o.v
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Вкладка верхнего уровня (как вкладки городов «Дашборда»): синяя плашка у выбранной. */
export function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="min-h-[40px] cursor-pointer rounded-[10px] px-4 text-[14px] font-bold leading-none transition-colors"
      style={active ? { background: C.primary, color: C.onPrimary } : { background: 'transparent', color: C.text }}
    >
      {children}
    </button>
  );
}

/** Поле-список без рамки (.sel макета). */
export function Select({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: { v: string; label: string }[]; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-[13px] font-medium" style={{ color: C.muted }}>
      {label}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-10 max-w-[min(100%,420px)] cursor-pointer rounded-[10px] border-0 px-3.5 text-base font-medium outline-none sm:text-[14px]"
        style={{ background: C.surface, color: C.text }}
      >
        {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'warn' }) {
  const color = tone === 'error' ? C.error : tone === 'warn' ? C.warn : C.primary;
  return (
    <div className="rounded-[10px] px-4 py-3 text-[14px] font-medium" style={{ background: C.surface, borderLeft: `4px solid ${color}`, color: C.text }}>
      {children}
    </div>
  );
}

export function Loading({ text }: { text: string }) {
  return <div className="px-1 py-6 text-[14px] font-medium" style={{ color: C.muted }}>{text}</div>;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function headerDate(today: string): string {
  return new Date(`${today}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function cumulative(arr: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [];
  let s = 0;
  for (const v of arr) {
    if (v === null) { out.push(null); continue; }
    s += v; out.push(s);
  }
  return out;
}

// ── Таблица план/факт (таблица макета: шапка серо-голубая 13/700, строка 40px,
//    разделители 1px, итог — серый фон, числа табличные) ───────────────────────
// Компактно (правка владельца 10.10: «зачем столько пустого места»): строка 28px, 12px, отступ 8px.
const TH = 'h-7 whitespace-nowrap px-2 text-right text-[12px] font-bold leading-none';
const TD = 'h-7 whitespace-nowrap px-2 text-right text-[12px] font-medium tabular-nums leading-none';
const GROUP_LEFT: CSSProperties = { borderLeft: `2px solid ${C.line}` };

export function PlanFactTable({ lines, cal, kind, unit, money, view, density = 'full', lowerIsBetter = false, emptyText }: {
  lines: TableLine[];
  cal: CalendarInfo;
  kind: BlockKind;
  unit: BlockUnit;
  money: MoneyUnit;
  view: ViewMode;
  density?: Density;
  lowerIsBetter?: boolean;
  emptyText?: string;
}) {
  const cur = cal.currentMonth;
  const weight = cal.currentMonthWeight;
  const cumul = view === 'cumulative' && kind === 'sum';
  const onlyPct = density === 'pct';
  const monthCols = onlyPct ? 1 : 3;
  const border = `1px solid ${C.track}`;

  const monthPlanCmp = (plan: number[] | null, i: number): number | null => {
    if (!plan || i > cur) return null;
    if (kind !== 'sum') return plan[i];
    if (cumul) {
      let s = 0;
      for (let k = 0; k <= i; k++) s += k === cur ? plan[k] * weight : plan[k];
      return s;
    }
    return i === cur ? plan[i] * weight : plan[i];
  };

  if (lines.length === 0) {
    return <div className="px-1 py-4 text-[14px] font-medium" style={{ color: C.muted }}>{emptyText ?? 'Нет строк.'}</div>;
  }

  const rowBg = (l: TableLine) => (l.level === 'total' ? C.mutedBg : l.level === 'group' ? C.group : C.surface);

  return (
    <div className="scroll-x rounded-[10px]" style={{ border }}>
      <table className="w-max min-w-full border-collapse text-[12px]" style={{ color: C.text }}>
        <thead className="sticky top-0 z-20">
          <tr style={{ background: C.group }}>
            <th rowSpan={2} className="sticky left-0 z-30 h-7 min-w-[170px] px-2 text-left text-[12px] font-bold max-md:min-w-[140px] max-md:max-w-[140px]" style={{ background: C.group, borderBottom: border }}>
              Строка
            </th>
            <th colSpan={4} className={`${TH} text-center`} style={{ ...GROUP_LEFT, borderBottom: border }}>С начала года</th>
            <th className={`${TH} text-center`} style={{ ...GROUP_LEFT, borderBottom: border }}>Год</th>
            {MONTHS.map((m, i) => (
              <th key={m} colSpan={monthCols} className={`${TH} text-center`} style={{ ...GROUP_LEFT, borderBottom: border, color: i === cur ? C.primary : i > cur ? C.muted : C.text }}>
                {MONTH_SHORT[i]}
                {i === cur && <span className="ml-1 font-medium">· {cal.workingDays.passed}/{cal.workingDays.total} р.д.</span>}
              </th>
            ))}
          </tr>
          <tr style={{ background: C.group, color: C.muted }}>
            <th className={TH} style={{ ...GROUP_LEFT, borderBottom: border }}>План к дате</th>
            <th className={TH} style={{ borderBottom: border }}>Факт</th>
            <th className={TH} style={{ borderBottom: border }}>%</th>
            <th className={TH} style={{ borderBottom: border }}>Откл.</th>
            <th className={TH} style={{ ...GROUP_LEFT, borderBottom: border }}>План</th>
            {MONTHS.map((m, i) => (
              <Fragment key={m}>
                {!onlyPct && <th className={TH} style={{ ...GROUP_LEFT, borderBottom: border, color: i > cur ? C.base : C.muted }}>План</th>}
                {!onlyPct && <th className={TH} style={{ borderBottom: border, color: i > cur ? C.base : C.muted }}>Факт</th>}
                <th className={TH} style={{ ...(onlyPct ? GROUP_LEFT : {}), borderBottom: border, color: i > cur ? C.base : C.muted }}>%</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map(row => {
            const planSeries = row.planMonths ? (cumul ? (cumulative(row.planMonths) as number[]) : row.planMonths) : null;
            const factSeries = cumul ? cumulative(row.factMonths) : row.factMonths;
            const delta = row.factYtd !== null && row.planToDate !== null ? row.factYtd - row.planToDate : null;
            const bold = row.level !== 'row';
            const bg = rowBg(row);
            return (
              <tr key={row.key} className="ssp-row" style={{ background: bg, opacity: row.muted ? 0.7 : 1, fontWeight: bold ? 700 : undefined }}>
                <td
                  className="sticky left-0 z-10 h-7 min-w-[170px] px-2 text-left text-[12px] leading-none max-md:min-w-[140px] max-md:max-w-[140px] max-md:truncate"
                  style={{ background: bg, borderBottom: border }}
                  title={row.note ? `${row.label} — ${row.note}` : row.label}
                >
                  {row.level === 'row' && <span className="inline-block w-3" />}
                  {row.label}
                  {row.note && <sup className="ml-0.5" style={{ color: C.muted }}>*</sup>}
                </td>
                <td className={TD} style={{ ...GROUP_LEFT, borderBottom: border, color: C.muted }}>{fmtVal(row.planToDate, unit, money)}</td>
                <td className={`${TD} font-bold`} style={{ borderBottom: border }}>{fmtVal(row.factYtd, unit, money)}</td>
                <td className={`${TD} font-bold`} style={{ borderBottom: border, ...heatStyle(heatRatio(row.factYtd, row.planToDate, lowerIsBetter)) }}>{fmtPct(row.factYtd, row.planToDate)}</td>
                <td className={TD} style={{ borderBottom: border, color: toneColor(delta, lowerIsBetter) }}>{fmtDelta(delta, unit, money)}</td>
                <td className={TD} style={{ ...GROUP_LEFT, borderBottom: border, color: C.muted }}>{fmtVal(row.planYear, unit, money)}</td>
                {MONTHS.map((m, i) => {
                  const isFuture = i > cur;
                  const plan = planSeries ? planSeries[i] : null;
                  const fact = isFuture ? null : factSeries[i];
                  const planCmp = monthPlanCmp(row.planMonths, i);
                  const heat = isFuture ? undefined : heatStyle(heatRatio(fact, planCmp, lowerIsBetter));
                  const hint = onlyPct ? `План ${fmtVal(plan, unit, money)} · Факт ${isFuture ? '—' : fmtVal(fact, unit, money)}` : undefined;
                  return (
                    <Fragment key={m}>
                      {!onlyPct && <td className={TD} style={{ ...GROUP_LEFT, borderBottom: border, color: isFuture ? C.base : C.muted }}>{fmtVal(plan, unit, money)}</td>}
                      {!onlyPct && <td className={TD} style={{ borderBottom: border, color: isFuture ? C.base : C.text }}>{isFuture ? '—' : fmtVal(fact, unit, money)}</td>}
                      <td className={`${TD} ${onlyPct ? 'font-bold' : ''}`} style={{ ...(onlyPct ? GROUP_LEFT : {}), borderBottom: border, color: isFuture ? C.base : C.text, ...heat }} title={hint}>
                        {isFuture ? '—' : fmtPct(fact, planCmp)}
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
