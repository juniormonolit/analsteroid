'use client';
// Раздел «Презентация» (ТЗ владельца 11.08): типовые слайды еженедельного
// собрания. Формат и набор метрик — согласованный макет разовой версии по
// Москве (WORKLOG 2026-08-11): крупная вёрстка под 16:9, план/факт-дашборд,
// динамика по дням, год к году, менеджеры по группам, товарные группы с
// переключателем «Категория КЦ»/«По наибольшему», «Выводы» — contenteditable.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, subDays, startOfDay, endOfDay, differenceInCalendarDays, addDays } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Maximize, Loader2 } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import type { DateRange } from '@/lib/period';
import { previousPeriodSameLength, periodDateStrFromInstant } from '@/lib/period';
import { DepartmentPicker, PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import type { MetricWindow, PresentationData } from '../engine/presentation';

// ── Форматирование ───────────────────────────────────────────────────────────
const mln = (v: number) => (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const pc = (a: number, b: number) => (b > 0 ? Math.round((100 * a) / b) : null);
const fmtD = (d: Date) => format(d, 'dd.MM.yyyy', { locale: ru });

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (!(prev > 0)) return <span className="text-[var(--color-text-muted)]">—</span>;
  const d = Math.round((100 * (cur - prev)) / prev);
  return (
    <span className={`font-semibold ${d >= 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
      {d >= 0 ? '+' : ''}{d}%
    </span>
  );
}
// Тихие нули (правка владельца по макету: «пустое не должно спорить с цифрами»)
const Z = () => <span className="text-[var(--color-text-muted)] opacity-60">—</span>;
const NumCell = ({ v, f = mln, strong = false }: { v: number; f?: (v: number) => string; strong?: boolean }) => {
  if (v <= 0) return <Z />;
  const s = f(v);
  return s === '0' ? <span className="text-[var(--color-text-muted)] opacity-60">0</span>
    : <span className={strong ? 'font-semibold' : undefined}>{s}</span>;
};
const CrCell = ({ n, d }: { n: number; d: number }) => {
  const v = pc(n, d);
  if (v === null) return <Z />;
  return v === 0 ? <span className="text-[var(--color-text-muted)] opacity-60">0%</span> : <span>{v}%</span>;
};

// ── Общие куски вёрстки ──────────────────────────────────────────────────────
const CARD = 'bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-2xl';
const TD = 'py-[0.45em] pr-[0.9em] border-b border-[var(--color-border)]';
const TDNUM = `${TD} text-right tabular-nums whitespace-nowrap`;
const GSEP = 'border-l border-[var(--color-border)] pl-[1.1em]';
const TH = 'text-[var(--color-text-muted)] font-medium uppercase tracking-[0.06em] text-[0.72em]';

function Slide({ children, center = false }: { children: React.ReactNode; center?: boolean }) {
  return (
    <section className={`min-h-full snap-start flex flex-col justify-center px-[4vw] py-[4vh] max-w-[1900px] mx-auto w-full ${center ? 'items-center text-center' : ''}`}>
      {children}
    </section>
  );
}
function SlideHead({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 flex-wrap mb-[2.4vh]">
      <header className="min-w-0">
        <h2 className="text-[clamp(26px,3.6vw,56px)] font-bold tracking-tight text-[var(--color-text)] m-0">{title}</h2>
        {sub && <p className="text-[var(--color-text-muted)] text-[clamp(13px,1.25vw,22px)] m-0">{sub}</p>}
      </header>
      {right}
    </div>
  );
}

// ── Таблица метрик менеджеров/товарных групп (согласованный макет v2) ────────
interface NamedRow extends MetricWindow { name: string }
function MetricTable({ label, rows, total, topN = 11 }: {
  label: string; rows: NamedRow[]; total: MetricWindow; topN?: number;
}) {
  const top = rows.slice(0, topN);
  const rest = rows.slice(topN);
  const restSum: MetricWindow | null = rest.length
    ? rest.reduce((acc, r) => {
        for (const k of Object.keys(acc) as (keyof MetricWindow)[]) acc[k] += r[k];
        return acc;
      }, { sales_p: 0, sales_r: 0, sales_n_p: 0, sales_n_r: 0, ship_p: 0, ship_r: 0, ship_n_p: 0, inbound: 0, inbound_p: 0, ppo: 0 })
    : null;

  const cells = (w: MetricWindow) => (
    <>
      <td className={`${TDNUM} ${GSEP}`}><NumCell v={w.sales_p} strong /></td>
      <td className={TDNUM}><NumCell v={w.sales_r} /></td>
      <td className={`${TDNUM} ${GSEP}`}><NumCell v={w.ship_p} strong /></td>
      <td className={TDNUM}><NumCell v={w.ship_r} /></td>
      <td className={`${TDNUM} ${GSEP}`}><NumCell v={w.inbound} f={String} /></td>
      <td className={`${TDNUM} ${GSEP}`}><CrCell n={w.sales_n_p} d={w.inbound_p} /></td>
      <td className={TDNUM}><CrCell n={w.ship_n_p} d={w.inbound_p} /></td>
      <td className={`${TDNUM} ${GSEP}`}><CrCell n={w.sales_n_r} d={w.sales_n_p + w.sales_n_r} /></td>
    </>
  );

  return (
    <div className="scroll-x">
      <table className="w-full border-collapse text-[clamp(13px,1.15vw,21px)] min-w-[820px]">
        <thead>
          <tr>
            <th rowSpan={2} className={`${TD} ${TH} text-left align-bottom`}>{label}</th>
            <th colSpan={2} className={`${TH} ${GSEP} text-center pb-0.5`}>Продажи, млн</th>
            <th colSpan={2} className={`${TH} ${GSEP} text-center pb-0.5`}>Отгрузки, млн</th>
            <th rowSpan={2} className={`${TD} ${TH} ${GSEP} text-right align-bottom`}>Входящих</th>
            <th colSpan={2} className={`${TH} ${GSEP} text-center pb-0.5`}>CR первичная</th>
            <th rowSpan={2} className={`${TD} ${TH} ${GSEP} text-right align-bottom`}>Доля повт.</th>
          </tr>
          <tr>
            <th className={`${TDNUM} ${TH} ${GSEP} pt-0.5`}>перв.</th>
            <th className={`${TDNUM} ${TH} pt-0.5`}>повт.</th>
            <th className={`${TDNUM} ${TH} ${GSEP} pt-0.5`}>перв.</th>
            <th className={`${TDNUM} ${TH} pt-0.5`}>повт.</th>
            <th className={`${TDNUM} ${TH} ${GSEP} pt-0.5`}>в продажу</th>
            <th className={`${TDNUM} ${TH} pt-0.5`}>в отгрузку</th>
          </tr>
        </thead>
        <tbody>
          {top.map(r => (
            <tr key={r.name} className="odd:bg-[var(--color-report-zebra)]">
              <td className={`${TD} text-[var(--color-text)]`}>{r.name}</td>
              {cells(r)}
            </tr>
          ))}
          {restSum && (
            <tr className="text-[var(--color-text-muted)] odd:bg-[var(--color-report-zebra)]">
              <td className={TD}>Остальные ({rest.length})</td>
              {cells(restSum)}
            </tr>
          )}
          <tr className="font-bold">
            <td className="py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)]">ИТОГО</td>
            {/* та же строка ячеек, но с жирной верхней границей */}
            <td className={`text-right tabular-nums whitespace-nowrap py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)] ${GSEP}`}><NumCell v={total.sales_p} strong /></td>
            <td className="text-right tabular-nums whitespace-nowrap py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)]"><NumCell v={total.sales_r} /></td>
            <td className={`text-right tabular-nums whitespace-nowrap py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)] ${GSEP}`}><NumCell v={total.ship_p} strong /></td>
            <td className="text-right tabular-nums whitespace-nowrap py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)]"><NumCell v={total.ship_r} /></td>
            <td className={`text-right tabular-nums whitespace-nowrap py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)] ${GSEP}`}><NumCell v={total.inbound} f={String} /></td>
            <td className={`text-right tabular-nums whitespace-nowrap py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)] ${GSEP}`}><CrCell n={total.sales_n_p} d={total.inbound_p} /></td>
            <td className="text-right tabular-nums whitespace-nowrap py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)]"><CrCell n={total.ship_n_p} d={total.inbound_p} /></td>
            <td className={`text-right tabular-nums whitespace-nowrap py-[0.5em] pr-[0.9em] border-t-2 border-[var(--color-text)] ${GSEP}`}><CrCell n={total.sales_n_r} d={total.sales_n_p + total.sales_n_r} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── План/факт: карточки с прогресс-барами ────────────────────────────────────
function ProgressBar({ fact, plan, color }: { fact: number; plan: number; color: string }) {
  const p = Math.min(pc(fact, plan) ?? 0, 100);
  return (
    <div className="h-[clamp(10px,0.9vw,16px)] rounded-full bg-[var(--color-border)] overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${p}%`, background: color }} />
    </div>
  );
}
function HeroCard({ label, fact, plan, color, asOf }: { label: string; fact: number; plan: number; color: string; asOf: string }) {
  return (
    <div className={`${CARD} p-[clamp(16px,2vw,36px)]`}>
      <span className={TH}>{label}</span>
      <div className="text-[clamp(44px,5.8vw,104px)] font-bold leading-[1.05] tracking-tight text-[var(--color-text)]">
        {mln(fact)}
        <span className="text-[0.32em] font-medium text-[var(--color-text-muted)]"> из {mln(plan)} млн</span>
      </div>
      <div className="text-[clamp(22px,2.4vw,42px)] font-bold mb-[0.5em] text-[var(--color-text)]">
        {pc(fact, plan) === null ? '—' : `${pc(fact, plan)}%`}
        <span className="text-[0.5em] font-normal text-[var(--color-text-muted)]"> плана на {asOf}</span>
      </div>
      <ProgressBar fact={fact} plan={plan} color={color} />
    </div>
  );
}

// ── Страница ─────────────────────────────────────────────────────────────────
function defaultPresPeriod(): DateRange {
  // ТЗ: дефолт — прошедшая неделя (сегодня−7 … вчера)
  const now = new Date();
  return { from: startOfDay(subDays(now, 7)), to: endOfDay(subDays(now, 1)) };
}

const SALES_COLOR = 'var(--color-accent)';
const SHIP_COLOR = '#2a78d6';
const PREV_COLOR = 'var(--color-border-strong)';

export function PresentationPage() {
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [period, setPeriod] = useState<DateRange>(defaultPresPeriod);
  const [comparison, setComparison] = useState<DateRange>(() => previousPeriodSameLength(defaultPresPeriod()));
  const [pgMode, setPgMode] = useState<'kc' | 'by_max'>('kc');
  const deckRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);

  const params = useMemo(() => ({
    departmentIds,
    period: { from: periodDateStrFromInstant(period.from, 'from'), to: periodDateStrFromInstant(period.to, 'to') },
    comparison: { from: periodDateStrFromInstant(comparison.from, 'from'), to: periodDateStrFromInstant(comparison.to, 'to') },
  }), [departmentIds, period, comparison]);

  const { data, isLoading, error } = useQuery<PresentationData>({
    queryKey: ['presentation', params],
    queryFn: async () => {
      const r = await fetch('/api/presentation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });

  // Листание клавиатурой (ТЗ: колесо/стрелки; колесо работает нативно за счёт
  // scroll-snap) + счётчик слайдов.
  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const sections = () => Array.from(deck.querySelectorAll('section'));
    const cur = () => Math.round(deck.scrollTop / deck.clientHeight);
    const upd = () => { setPage(cur() + 1); setPages(sections().length); };
    upd();
    deck.addEventListener('scroll', upd);
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.isContentEditable) return;
      const s = sections();
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) {
        e.preventDefault(); s[Math.min(cur() + 1, s.length - 1)]?.scrollIntoView({ behavior: 'smooth' });
      }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault(); s[Math.max(cur() - 1, 0)]?.scrollIntoView({ behavior: 'smooth' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { deck.removeEventListener('scroll', upd); window.removeEventListener('keydown', onKey); };
  }, [data]);

  const entityName = useMemo(() => {
    if (!data || data.groups.length === 0) return 'Компания';
    if (departmentIds.length === 0) return 'Компания';
    const names = data.groups.map(g => g.name);
    return names.length <= 3 ? names.join(' · ') : `${names.slice(0, 3).join(' · ')} и ещё ${names.length - 3}`;
  }, [data, departmentIds]);

  // График по дням: обе серии выравниваются по индексу дня внутри периода.
  const chartData = useMemo(() => {
    if (!data) return [];
    const len = differenceInCalendarDays(period.to, period.from) + 1;
    const curBy = new Map(data.daily.cur.map(p => [p.d, p]));
    const prevBy = new Map(data.daily.prev.map(p => [p.d, p]));
    const isWeek = len === 7;
    return Array.from({ length: len }, (_, i) => {
      const d = addDays(startOfDay(period.from), i);
      const iso = periodDateStrFromInstant(d, 'from');
      const pd = addDays(startOfDay(comparison.from), i);
      const pIso = periodDateStrFromInstant(pd, 'from');
      return {
        label: isWeek ? format(d, 'EEEEEE dd.MM', { locale: ru }) : format(d, 'dd.MM', { locale: ru }),
        cur: (curBy.get(iso)?.sales ?? 0) / 1e6,
        prev: (prevBy.get(pIso)?.sales ?? 0) / 1e6,
      };
    });
  }, [data, period, comparison]);

  const periodLabel = `${fmtD(period.from)} — ${fmtD(period.to)}`;
  const comparisonLabel = `${fmtD(comparison.from)} — ${fmtD(comparison.to)}`;

  return (
    <div className="h-full flex flex-col overflow-x-hidden bg-[var(--color-bg)]">
      {/* Тулбар настройки — вне полноэкранного контейнера, в fullscreen не попадает */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap px-3 py-2 border-b border-[var(--color-border)]">
        <DepartmentPicker departmentIds={departmentIds} onDepartmentIdsChange={setDepartmentIds} />
        <PeriodRangeControls
          period={period} comparison={comparison}
          onPeriodChange={setPeriod} onComparisonChange={setComparison}
          manualComparisonFn={previousPeriodSameLength}
        />
        <div className="flex-1" />
        <button
          onClick={() => {
            const el = deckRef.current?.parentElement;
            if (document.fullscreenElement) document.exitFullscreen();
            else el?.requestFullscreen();
          }}
          className="flex items-center gap-2 px-3 min-h-11 border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text)] hover:border-[var(--color-border-focus)] transition-colors"
        >
          <Maximize size={15} /> Во весь экран
        </button>
      </div>

      <div className="relative flex-1 min-h-0 bg-[var(--color-bg)]">
        <div ref={deckRef} className="h-full overflow-y-auto overflow-x-hidden snap-y snap-mandatory">
          {isLoading && (
            <div className="h-full flex items-center justify-center gap-2 text-[var(--color-text-muted)]">
              <Loader2 size={18} className="animate-spin" /> Собираем презентацию…
            </div>
          )}
          {error && !isLoading && (
            <div className="h-full flex items-center justify-center text-[var(--color-negative)] px-6 text-center">
              Не получилось собрать данные: {(error as Error).message}
            </div>
          )}
          {data && !isLoading && (
            <>
              {/* 1. Титул */}
              <Slide center>
                <h1 className="text-[clamp(44px,7.5vw,116px)] font-bold tracking-tight text-[var(--color-text)] m-0">Отчёт</h1>
                <h2 className="text-[clamp(26px,4.2vw,64px)] font-bold text-[var(--color-accent)] mt-[0.3em] m-0">{entityName}</h2>
                <h3 className="font-normal text-[var(--color-text-muted)] text-[clamp(15px,1.9vw,28px)] mt-[0.8em] m-0">
                  за {periodLabel} в сравнении с {comparisonLabel}
                </h3>
              </Slide>

              {/* 2. План / факт */}
              <Slide>
                <SlideHead
                  title="План / факт"
                  sub={`${format(new Date(`${data.planFact.monthFirstDay}T12:00:00`), 'LLLL', { locale: ru })} к ${format(new Date(`${data.planFact.asOf}T12:00:00`), 'dd.MM', { locale: ru })} · план на дату = месячный × ${data.planFact.workingDays.passed}/${data.planFact.workingDays.total} рабочих дней · млн ₽`}
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-[1.4vw] mb-[1.4vw]">
                  <HeroCard label="Продажи" fact={data.planFact.total.factSales} plan={data.planFact.total.planSalesMtd}
                    color={SALES_COLOR} asOf={format(new Date(`${data.planFact.asOf}T12:00:00`), 'dd.MM')} />
                  <HeroCard label="Отгрузки" fact={data.planFact.total.factShip} plan={data.planFact.total.planShipMtd}
                    color={SHIP_COLOR} asOf={format(new Date(`${data.planFact.asOf}T12:00:00`), 'dd.MM')} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[1.4vw]">
                  {data.groups.map(g => {
                    const pf = data.planFact.byGroup[g.key];
                    return (
                      <div key={g.key} className={`${CARD} p-[clamp(14px,1.6vw,28px)]`}>
                        <h3 className="text-[clamp(18px,1.9vw,32px)] font-bold text-[var(--color-text)] m-0 mb-[0.5em]">{g.name}</h3>
                        {([['Продажи', pf.factSales, pf.planSalesMtd, SALES_COLOR],
                           ['Отгрузки', pf.factShip, pf.planShipMtd, SHIP_COLOR]] as const).map(([lbl, fact, plan, color]) => (
                          <div key={lbl} className="mt-[0.7em]">
                            <div className="flex items-baseline gap-[0.6em]">
                              <span className={TH}>{lbl}</span>
                              <b className="text-[clamp(17px,1.7vw,30px)] tabular-nums text-[var(--color-text)]">
                                {mln(fact)}<span className="text-[0.62em] font-normal text-[var(--color-text-muted)]"> / {mln(plan)}</span>
                              </b>
                              <b className="ml-auto text-[clamp(17px,1.7vw,30px)] tabular-nums text-[var(--color-text)]">
                                {pc(fact, plan) === null ? '—' : `${pc(fact, plan)}%`}
                              </b>
                            </div>
                            <ProgressBar fact={fact} plan={plan} color={color} />
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </Slide>

              {/* 3. Период по дням */}
              <Slide>
                <SlideHead title="Период по дням" sub={`Продажи ${periodLabel} против ${comparisonLabel} · млн ₽`} />
                <div className={`${CARD} p-[clamp(12px,1.4vw,26px)]`}>
                  <div className="scroll-x">
                    <div className="min-w-[720px]" style={{ height: 'min(44vh, 480px)' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                          <CartesianGrid vertical={false} stroke="var(--color-border)" />
                          <XAxis dataKey="label" tick={{ fill: 'var(--color-text-muted)', fontSize: 13 }} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
                          <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 13 }} tickLine={false} axisLine={false} width={36} />
                          <Tooltip
                            formatter={(v, name) => [`${mln((Number(v) || 0) * 1e6)} млн`, name]}
                            contentStyle={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 10, color: 'var(--color-text)' }}
                            cursor={{ fill: 'var(--color-bg-hover)' }}
                          />
                          <Legend wrapperStyle={{ color: 'var(--color-text-muted)' }} />
                          <Bar name={`Сравнение ${comparisonLabel}`} dataKey="prev" fill={PREV_COLOR} radius={[4, 4, 0, 0]} />
                          <Bar name={`Период ${periodLabel}`} dataKey="cur" fill={SALES_COLOR} radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-[1.4vw] mt-[1.4vw]">
                  {([
                    ['Продажи за период', (data.period.total.sales_p + data.period.total.sales_r), (data.comparison.total.sales_p + data.comparison.total.sales_r), true],
                    ['Отгрузки за период', (data.period.total.ship_p + data.period.total.ship_r), (data.comparison.total.ship_p + data.comparison.total.ship_r), true],
                    ['Сделок продано', (data.period.total.sales_n_p + data.period.total.sales_n_r), (data.comparison.total.sales_n_p + data.comparison.total.sales_n_r), false],
                  ] as const).map(([lbl, cur, prev, isMln]) => (
                    <div key={lbl} className={`${CARD} p-[clamp(14px,1.5vw,26px)]`}>
                      <span className="text-[var(--color-text-muted)] text-[clamp(13px,1.15vw,20px)]">{lbl}</span>
                      <b className="block text-[clamp(28px,3.2vw,56px)] font-bold tracking-tight text-[var(--color-text)]">
                        {isMln ? `${mln(cur)} млн` : cur} <Delta cur={cur} prev={prev} />
                      </b>
                      <span className="text-[var(--color-text-muted)] text-[clamp(13px,1.15vw,20px)]">
                        сравнение: {isMln ? `${mln(prev)} млн` : prev}
                      </span>
                    </div>
                  ))}
                </div>
              </Slide>

              {/* 4. Год к году: месяц-до-даты по концу периода, CR — первичные */}
              <Slide>
                <SlideHead
                  title="Год к году"
                  sub={`${format(new Date(`${data.yoy.from}T12:00:00`), 'd MMMM', { locale: ru })} – ${format(new Date(`${data.yoy.to}T12:00:00`), 'd MMMM yyyy', { locale: ru })} против того же периода ${data.yoy.prevFrom.slice(0, 4)} · в скобках — прошлый год · CR — первичные к первичным входящим · ППО — вторая отгрузка клиента`}
                />
                <div className="scroll-x">
                  <table className="w-full border-collapse text-[clamp(13px,1.3vw,24px)] min-w-[760px]">
                    <thead>
                      <tr>
                        <th className={`${TD} ${TH} text-left`} />
                        {['Продажи, млн', 'Отгрузки, млн', 'Входящих', 'CR перв. в продажу', 'CR перв. в отгрузку', 'Доля повторных', 'ППО'].map(h => (
                          <th key={h} className={`${TDNUM} ${TH}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.groups.map(g => ({ label: g.name, cur: data.yoy.byGroup[g.key], prev: data.yoy.prevByGroup[g.key], total: false })),
                        { label: 'ИТОГО', cur: data.yoy.total, prev: data.yoy.prevTotal, total: true }].map(({ label, cur: c, prev: p, total }) => (
                        <tr key={label} className={total ? 'font-bold [&>td]:border-t-2 [&>td]:border-[var(--color-text)] [&>td]:border-b-0' : 'odd:bg-[var(--color-report-zebra)]'}>
                          <td className={TD}>{label}</td>
                          <td className={TDNUM}>{mln(c.sales_p + c.sales_r)} <Delta cur={c.sales_p + c.sales_r} prev={p.sales_p + p.sales_r} /></td>
                          <td className={TDNUM}>{mln(c.ship_p + c.ship_r)} <Delta cur={c.ship_p + c.ship_r} prev={p.ship_p + p.ship_r} /></td>
                          <td className={TDNUM}>{c.inbound} <Delta cur={c.inbound} prev={p.inbound} /></td>
                          <td className={TDNUM}><CrCell n={c.sales_n_p} d={c.inbound_p} /> <span className="text-[var(--color-text-muted)]">(<CrCell n={p.sales_n_p} d={p.inbound_p} />)</span></td>
                          <td className={TDNUM}><CrCell n={c.ship_n_p} d={c.inbound_p} /> <span className="text-[var(--color-text-muted)]">(<CrCell n={p.ship_n_p} d={p.inbound_p} />)</span></td>
                          <td className={TDNUM}><CrCell n={c.sales_n_r} d={c.sales_n_p + c.sales_n_r} /> <span className="text-[var(--color-text-muted)]">(<CrCell n={p.sales_n_r} d={p.sales_n_p + p.sales_n_r} />)</span></td>
                          <td className={TDNUM}>{c.ppo > 0 ? c.ppo : <Z />} <Delta cur={c.ppo} prev={p.ppo} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Slide>

              {/* 5+. Менеджеры: слайд = группа (отдел/филиал) */}
              {data.groups.filter(g => data.managers[g.key]?.length).map(g => (
                <Slide key={g.key}>
                  <SlideHead
                    title={`${g.name} — по менеджерам`}
                    sub={`${periodLabel} · первичные/повторные — по воронке · CR = первичные продажи (отгрузки) к первичным входящим`}
                  />
                  <MetricTable label="Менеджер" rows={data.managers[g.key]} total={data.period.byGroup[g.key]} />
                </Slide>
              ))}

              {/* Товарные группы с переключателем системы группировки */}
              <Slide>
                <SlideHead
                  title="По товарным группам"
                  sub={`${periodLabel} · топ-10 по продажам · CR = первичные продажи (отгрузки) к первичным входящим`}
                  right={
                    <div className="inline-flex border border-[var(--color-border)] rounded-xl overflow-hidden" role="group" aria-label="Система товарных групп">
                      {([['kc', 'Категория КЦ'], ['by_max', 'По наибольшему']] as const).map(([mode, lbl]) => (
                        <button
                          key={mode}
                          onClick={() => setPgMode(mode)}
                          aria-pressed={pgMode === mode}
                          className={`px-4 min-h-11 text-[clamp(13px,1.1vw,19px)] transition-colors ${
                            pgMode === mode
                              ? 'bg-[var(--color-bg-surface)] text-[var(--color-text)] font-semibold'
                              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  }
                />
                <MetricTable label="Группа" rows={data.productGroups[pgMode]} total={data.period.total} topN={10} />
              </Slide>

              {/* Выводы */}
              <Slide>
                <SlideHead title="Выводы и идеи" sub="Кликните и пишите — текст остаётся на экране до закрытия страницы" />
                <div
                  contentEditable
                  suppressContentEditableWarning
                  className={`${CARD} border-dashed p-[clamp(14px,1.6vw,28px)] min-h-[42vh] outline-none focus:border-[var(--color-accent)] text-[clamp(17px,1.8vw,32px)] text-[var(--color-text)]`}
                >
                  •&nbsp;
                </div>
              </Slide>
            </>
          )}
        </div>
        {data && !isLoading && (
          <div className="absolute bottom-2 right-3 text-[var(--color-text-muted)] text-xs tabular-nums pointer-events-none">
            {page} / {pages}
          </div>
        )}
      </div>
    </div>
  );
}
