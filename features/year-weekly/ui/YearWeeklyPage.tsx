'use client';
import { Fragment, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { EntityKey, EntityMetrics, YearWeeklyResult } from '@/features/year-weekly/shared';

// Спец-отчёт «Данные по годам» — зеркало ручного файла владельца (скрин 28.08):
// понедельный «год к году», строки 2025г/2026г/План на каждую неделю + месячные
// ИТОГО, заливка колонок по метрикам (продажи — голубой, отгрузки — зелёный,
// конверсии — жёлтый), «Откл» цветным бейджем, погода городов текстом.
// Таблица широкая — живёт в собственном scroll-x (правило 2 CLAUDE.md),
// первые колонки (год/неделя) — sticky.

type MetricKey = 'deals' | 'salesSum' | 'shipSum' | 'crSale' | 'crShip' | 'avgCheck';
const METRICS: { key: MetricKey; label: string; kind: 'count' | 'money' | 'pct'; tint: string }[] = [
  { key: 'deals', label: 'Кол-во сделок', kind: 'count', tint: 'transparent' },
  { key: 'salesSum', label: 'Сумма продаж', kind: 'money', tint: 'color-mix(in srgb, #4aa3e0 12%, transparent)' },
  { key: 'shipSum', label: 'Сумма отгрузок', kind: 'money', tint: 'color-mix(in srgb, #2f9e44 10%, transparent)' },
  { key: 'crSale', label: 'Конв. продажа', kind: 'pct', tint: 'color-mix(in srgb, #f5c518 16%, transparent)' },
  { key: 'crShip', label: 'Конв. отгрузка', kind: 'pct', tint: 'color-mix(in srgb, #e8930c 14%, transparent)' },
  { key: 'avgCheck', label: 'Средний чек', kind: 'money', tint: 'transparent' },
];
// СПБ/МСК ИТОГО в файле — только продажи и отгрузки.
const TOTAL_METRICS = METRICS.filter(m => m.key === 'salesSum' || m.key === 'shipSum');

const CITY_LABEL: Record<string, string> = { spb: 'Погода СПБ', msk: 'Погода МСК', krd: 'Погода КРД' };

function fmt(v: number | null | undefined, kind: 'count' | 'money' | 'pct'): string {
  if (v === null || v === undefined) return '—';
  if (kind === 'pct') return `${(v * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  if (kind === 'money') return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  return Math.round(v).toLocaleString('ru-RU');
}

function Dev({ cur, prev, kind }: { cur: number | null | undefined; prev: number | null | undefined; kind: 'count' | 'money' | 'pct' }) {
  if (cur == null || prev == null) return <span className="text-[var(--color-text-muted)]">—</span>;
  // Конверсии — разница в п.п. (проценты от процентов сбивают с толку),
  // деньги/количества — относительный %.
  if (kind === 'pct') {
    const d = (cur - prev) * 100;
    if (Math.abs(d) < 0.05) return <span className="text-[var(--color-text-muted)]">0</span>;
    const pos = d > 0;
    return <span className={`rounded px-1 font-semibold ${pos ? 'bg-[var(--color-positive,#2f9e44)]/15 text-[var(--color-positive,#2f9e44)]' : 'bg-[var(--color-negative,#e03131)]/15 text-[var(--color-negative,#e03131)]'}`}>
      {pos ? '+' : '−'}{Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}
    </span>;
  }
  if (prev === 0) return <span className="text-[var(--color-text-muted)]">—</span>;
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return <span className="text-[var(--color-text-muted)]">0%</span>;
  const pos = d > 0;
  return <span className={`rounded px-1 font-semibold ${pos ? 'bg-[var(--color-positive,#2f9e44)]/15 text-[var(--color-positive,#2f9e44)]' : 'bg-[var(--color-negative,#e03131)]/15 text-[var(--color-negative,#e03131)]'}`}>
    {pos ? '+' : '−'}{Math.abs(d * 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%
  </span>;
}

interface TriRow {
  kind: 'prev' | 'cur' | 'plan';
  yearLabel: string;
  weekLabel: string;
  monthBoundary?: boolean;   // серая полоса-разделитель ПЕРЕД блоком
  isTotal?: boolean;         // месячные ИТОГО — фон
  weekStart?: string;        // у cur-строки — ключ погоды
  get: (e: EntityKey) => EntityMetrics | null;
  getPlan?: (e: EntityKey) => { sales: number | null; ship: number | null };
}

export function YearWeeklyPage({ isSuperadmin }: { isSuperadmin: boolean }) {
  const nowYear = new Date().getFullYear();
  const [year, setYear] = useState(nowYear);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<YearWeeklyResult>({
    queryKey: ['year-weekly', year],
    queryFn: async () => {
      const res = await fetch(`/api/year-weekly?year=${year}`);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const [editWeather, setEditWeather] = useState<{ city: string; weekStart: string; text: string } | null>(null);

  const weatherBy = useMemo(() => {
    const m = new Map<string, { manual: string | null; auto: string | null }>();
    for (const w of data?.weather ?? []) m.set(`${w.city}:${w.weekStart}`, { manual: w.manualText, auto: w.autoSummary });
    return m;
  }, [data]);

  // Строки: недели месяца → ИТОГО месяца → следующая тройка.
  const rows = useMemo((): TriRow[] => {
    if (!data) return [];
    const out: TriRow[] = [];
    let lastMonth = 0;
    for (const w of data.weeks) {
      const boundary = w.month !== lastMonth;
      if (w.month !== lastMonth && lastMonth !== 0) {
        const mb = data.months.find(m => m.month === lastMonth);
        if (mb) {
          out.push({ kind: 'prev', yearLabel: `${year - 1}г`, weekLabel: `${mb.label} ${year - 1}`, isTotal: true, get: e => mb.prev[e] });
          out.push({ kind: 'cur', yearLabel: `${year}г`, weekLabel: `${mb.label} ${year}`, isTotal: true, get: e => mb.cur[e] });
          out.push({ kind: 'plan', yearLabel: 'План', weekLabel: 'ИТОГО план', isTotal: true, get: () => null, getPlan: e => ({ sales: mb.planSales[e], ship: mb.planShip[e] }) });
        }
      }
      lastMonth = w.month;
      out.push({ kind: 'prev', yearLabel: `${year - 1}г`, weekLabel: w.prevLabel, monthBoundary: boundary, get: e => w.prev[e] });
      out.push({ kind: 'cur', yearLabel: `${year}г`, weekLabel: w.label, weekStart: w.weekStart, get: e => w.cur[e] });
      out.push({ kind: 'plan', yearLabel: '', weekLabel: 'План', get: () => null, getPlan: e => ({ sales: w.planSales[e], ship: w.planShip[e] }) });
    }
    // хвостовой ИТОГО текущего месяца
    const mb = data.months.find(m => m.month === lastMonth);
    if (mb) {
      out.push({ kind: 'prev', yearLabel: `${year - 1}г`, weekLabel: `${mb.label} ${year - 1}`, isTotal: true, monthBoundary: true, get: e => mb.prev[e] });
      out.push({ kind: 'cur', yearLabel: `${year}г`, weekLabel: `${mb.label} ${year}`, isTotal: true, get: e => mb.cur[e] });
      out.push({ kind: 'plan', yearLabel: 'План', weekLabel: 'ИТОГО план', isTotal: true, get: () => null, getPlan: e => ({ sales: mb.planSales[e], ship: mb.planShip[e] }) });
    }
    return out;
  }, [data, year]);

  // Пары строк для «Откл»: cur сравнивается с prev той же тройки.
  const prevOf = (idx: number): TriRow | null => (rows[idx]?.kind === 'cur' && rows[idx - 1]?.kind === 'prev' ? rows[idx - 1] : null);

  const entities = data?.entities ?? [];
  const stickyBg = 'bg-[var(--color-bg-surface)]';

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[var(--color-bg)]">
      <div className="p-4 sm:p-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-[var(--color-text)]">Данные по годам</h1>
          <div className="flex overflow-hidden rounded-lg border border-[var(--color-border)]">
            {[nowYear - 1, nowYear].map(y => (
              <button key={y} type="button" onClick={() => setYear(y)}
                className={`tap-target min-h-8 px-3 text-xs font-semibold ${year === y ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                {y}
              </button>
            ))}
          </div>
          <span className="text-xs text-[var(--color-text-muted)]">
            неделя {year}-го против той же ISO-недели {year - 1}-го · план = месяц / 4 · конверсии — первичные
          </span>
        </div>

        {error ? <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось построить отчёт.</div>
        : isLoading || !data ? <div className="text-sm text-[var(--color-text-muted)]">Считаем год…</div>
        : (
          <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <table className="border-separate border-spacing-0 text-[12px] leading-tight tabular-nums">
              <thead>
                {/* ряд 1: сущности */}
                <tr>
                  <th className={`sticky left-0 z-30 ${stickyBg} border-b border-r border-[var(--color-border)] px-2 py-1`} colSpan={2} />
                  {entities.map(e => {
                    const ms = e.total ? TOTAL_METRICS : METRICS;
                    const weatherCol = e.total || e.key === 'krd' ? 1 : 0;
                    return (
                      <th key={e.key} colSpan={ms.length * 2 + weatherCol}
                        className="border-b border-r-2 border-[var(--color-border)] bg-[var(--color-bg-hover)] px-2 py-1.5 text-center font-bold text-[var(--color-text)] whitespace-nowrap">
                        {e.label}
                      </th>
                    );
                  })}
                </tr>
                {/* ряд 2: метрики */}
                <tr>
                  <th className={`sticky left-0 z-30 ${stickyBg} border-b border-r border-[var(--color-border)]`} colSpan={2} />
                  {entities.map(e => {
                    const ms = e.total ? TOTAL_METRICS : METRICS;
                    return (
                      <Fragment key={e.key}>
                        {(e.total || e.key === 'krd') && (
                          <th key={`${e.key}-w`} rowSpan={2} className="border-b border-r border-[var(--color-border)] px-2 py-1 align-bottom text-[11px] font-semibold text-[var(--color-text-muted)] min-w-[180px]">
                            {CITY_LABEL[e.city]}
                          </th>
                        )}
                        {ms.map(m => (
                          <th key={`${e.key}-${m.key}`} colSpan={2} style={{ background: m.tint }}
                            className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center font-semibold text-[var(--color-text)] whitespace-nowrap">
                            {m.label}
                          </th>
                        ))}
                      </Fragment>
                    );
                  })}
                </tr>
                {/* ряд 3: Факт/Откл */}
                <tr>
                  <th className={`sticky left-0 z-30 ${stickyBg} border-b-2 border-r border-[var(--color-border)]`} colSpan={2} />
                  {entities.flatMap(e => (e.total ? TOTAL_METRICS : METRICS).flatMap(m => [
                    <th key={`${e.key}-${m.key}-f`} style={{ background: m.tint }} className="border-b-2 border-[var(--color-border)] px-2 py-0.5 text-right text-[10px] font-medium text-[var(--color-text-muted)]">Факт</th>,
                    <th key={`${e.key}-${m.key}-d`} style={{ background: m.tint }} className="border-b-2 border-r border-[var(--color-border)] px-1 py-0.5 text-center text-[10px] font-medium text-[var(--color-text-muted)]">Откл</th>,
                  ]))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const prevRow = prevOf(idx);
                  const rowBg = r.isTotal ? 'bg-[var(--color-bg-hover)] font-semibold' : '';
                  const boundary = r.monthBoundary ? 'border-t-[6px] border-t-[var(--color-border)]' : '';
                  return (
                    <tr key={idx} className={rowBg}>
                      <td className={`sticky left-0 z-20 w-[52px] min-w-[52px] ${stickyBg} ${boundary} whitespace-nowrap border-b border-r border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] ${r.isTotal ? 'font-semibold' : ''}`}>{r.yearLabel}</td>
                      <td className={`sticky left-[52px] z-20 ${stickyBg} ${boundary} whitespace-nowrap border-b border-r-2 border-[var(--color-border)] px-2 py-1 ${r.kind === 'cur' ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>{r.weekLabel}</td>
                      {entities.flatMap(e => {
                        const ms = e.total ? TOTAL_METRICS : METRICS;
                        const cells: React.ReactNode[] = [];
                        if (e.total || e.key === 'krd') {
                          if (r.kind === 'cur' && r.weekStart) {
                            const w = weatherBy.get(`${e.city}:${r.weekStart}`);
                            cells.push(
                              <td key={`${e.key}-w`} className={`${boundary} border-b border-r border-[var(--color-border)] px-2 py-1 align-top max-w-[240px]`}>
                                <div className="flex items-start gap-1">
                                  <span className="whitespace-pre-wrap text-[11px] leading-snug text-[var(--color-text)]">
                                    {w?.manual ?? <span className="text-[var(--color-text-muted)]">{w?.auto ?? ''}</span>}
                                    {w?.manual && w.auto ? <span className="text-[var(--color-text-muted)]"> · {w.auto}</span> : null}
                                  </span>
                                  {isSuperadmin && (
                                    <button type="button" title="Поправить текст погоды"
                                      onClick={() => setEditWeather({ city: e.city, weekStart: r.weekStart!, text: w?.manual ?? '' })}
                                      className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">
                                      <Pencil size={11} />
                                    </button>
                                  )}
                                </div>
                              </td>,
                            );
                          } else {
                            cells.push(<td key={`${e.key}-w`} className={`${boundary} border-b border-r border-[var(--color-border)]`} />);
                          }
                        }
                        for (const m of ms) {
                          let fact: string;
                          if (r.kind === 'plan') {
                            const p = r.getPlan!(e.key);
                            fact = m.key === 'salesSum' ? fmt(p.sales, 'money') : m.key === 'shipSum' ? fmt(p.ship, 'money') : '—';
                          } else {
                            const v = r.get(e.key);
                            fact = fmt(v?.[m.key] ?? null, m.kind);
                          }
                          cells.push(
                            <td key={`${e.key}-${m.key}-f`} style={{ background: r.isTotal ? undefined : m.tint }}
                              className={`${boundary} whitespace-nowrap border-b border-[var(--color-border)] px-2 py-1 text-right`}>
                              {fact}
                            </td>,
                          );
                          cells.push(
                            <td key={`${e.key}-${m.key}-d`} style={{ background: r.isTotal ? undefined : m.tint }}
                              className={`${boundary} whitespace-nowrap border-b border-r border-[var(--color-border)] px-1 py-1 text-center text-[11px]`}>
                              {r.kind === 'cur' && prevRow
                                ? <Dev cur={r.get(e.key)?.[m.key] ?? null} prev={prevRow.get(e.key)?.[m.key] ?? null} kind={m.kind} />
                                : null}
                            </td>,
                          );
                        }
                        return cells;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editWeather && (
        <Modal open onOpenChange={o => { if (!o) setEditWeather(null); }} title="Погода за неделю" desktopWidth="sm:max-w-md">
          <div className="flex flex-col gap-3">
            <textarea value={editWeather.text} onChange={ev => setEditWeather({ ...editWeather, text: ev.target.value })}
              rows={4} maxLength={2000}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-sm" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditWeather(null)}
                className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
              <button type="button"
                onClick={async () => {
                  await fetch('/api/year-weekly/weather', {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ city: editWeather.city, weekStart: editWeather.weekStart, text: editWeather.text }),
                  });
                  setEditWeather(null);
                  void qc.invalidateQueries({ queryKey: ['year-weekly'] });
                }}
                className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-xs font-semibold text-[var(--color-text-inverse)]">Сохранить</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
