'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Repeat, Layers, ShoppingCart, Hourglass, Timer, PhoneCall, Zap, Truck, CalendarClock, Trophy } from 'lucide-react';
import type {
  RepeatReport, RepeatSegmentStats, RepeatTouchStats, RepeatManagerRow,
} from '@/features/reports/engine/repeat';

// Раздел «Повторные» (#1725), редизайн по заказу владельца 10.08 («сделай
// охуенно прикольным»). Данные и API не тронуты — только подача:
//   * герой-кольца Repeat Rate по сегментам (SVG, без библиотек);
//   * KPI-плитки с иконками вместо сухих строк;
//   * касания — три «дорожки времени» вместо таблицы;
//   * менеджеры — подиум топ-3 + таблица с барами и сортировкой по клику.
// Адаптив 375/768: сетки auto-fit, таблица в .scroll-x (правила CLAUDE.md).

const fmtInt = (n: number) => n.toLocaleString('ru-RU');
const fmtPct = (n: number | null, d = 1) =>
  n === null ? '—' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: d })}%`;
const fmtDays = (n: number | null) =>
  n === null ? '—' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} дн`;
const fmtNum = (n: number | null, d = 1) =>
  n === null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: d });

// Мин → человекочитаемо (мин / ч / дн) — касания сильно разного порядка (46 мин vs 4 дн).
function fmtMinutes(m: number | null): string {
  if (m === null) return '—';
  if (m < 90) return `${m.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} мин`;
  if (m < 60 * 24) return `${(m / 60).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ч`;
  return `${(m / 60 / 24).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} дн`;
}

const SEG_LABEL: Record<string, string> = { phys: 'Физлица', jur: 'Юрлица' };
const SEG_EMOJI: Record<string, string> = { phys: '🧍', jur: '🏢' };
const SCOPE_LABEL: Record<string, string> = { primary: 'Первичные', repeat: 'Повторные', all: 'Все сделки' };

/** Кольцо прогресса: SVG-дуга без библиотек. Анимация — CSS transition на
 *  stroke-dashoffset (стартового кадра достаточно: браузер анимирует от полного
 *  круга при первом рендере с уже посчитанным значением). */
function Ring({ pct, size = 148, stroke = 11, color, children }: {
  pct: number | null; size?: number; stroke?: number; color: string; children: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = pct === null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          stroke="color-mix(in srgb, var(--color-border) 60%, transparent)" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          stroke={color} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - filled)}
          style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(.22,1,.36,1)' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

function KpiTile({ icon, value, label, sub }: {
  icon: React.ReactNode; value: string; label: string; sub?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3.5 py-3 flex items-start gap-3 min-w-0">
      <span className="mt-0.5 shrink-0 grid place-items-center w-8 h-8 rounded-lg text-[var(--color-accent)]
        bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]">{icon}</span>
      <span className="min-w-0">
        <span className="block text-lg font-bold tabular-nums text-[var(--color-text)] leading-tight">{value}</span>
        <span className="block text-[11px] text-[var(--color-text-muted)]">{label}</span>
        {sub && <span className="block text-[10.5px] text-[var(--color-text-muted)] opacity-75">{sub}</span>}
      </span>
    </div>
  );
}

/** Герой сегмента: кольцо Repeat Rate + KPI-плитки. */
function SegmentHero({ s }: { s: RepeatSegmentStats }) {
  const color = s.segment === 'phys' ? 'var(--color-accent)' : 'var(--color-positive, #16a34a)';
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5
      relative overflow-hidden">
      {/* лёгкое свечение под кольцом — чистая декорация, работает в обеих темах */}
      <div className="pointer-events-none absolute -top-16 -right-16 w-56 h-56 rounded-full opacity-[0.07]"
        style={{ background: `radial-gradient(circle, ${color}, transparent 70%)` }} />
      <div className="flex items-center gap-2 mb-4">
        <span className="text-base">{SEG_EMOJI[s.segment]}</span>
        <span className="text-sm font-semibold text-[var(--color-text)]">{SEG_LABEL[s.segment]}</span>
        <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{fmtInt(s.clients)} клиентов</span>
      </div>
      <div className="flex flex-wrap items-center gap-4 sm:gap-6">
        <Ring pct={s.repeatRate} color={color}>
          <span className="text-3xl font-extrabold tabular-nums text-[var(--color-text)]">{fmtPct(s.repeatRate, 1)}</span>
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mt-0.5">Repeat Rate</span>
        </Ring>
        <div className="flex-1 min-w-[180px] grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <KpiTile icon={<Repeat size={15} />} value={fmtInt(s.repeatClients)} label="повторных клиентов"
            sub={`из ${fmtInt(s.clients)}`} />
          <KpiTile icon={<Layers size={15} />} value={fmtPct(s.complexRate)} label="комплексных (2+ группы)"
            sub={`${fmtInt(s.complexClients)} клиентов`} />
          <KpiTile icon={<ShoppingCart size={15} />} value={fmtNum(s.avgOrders)} label="заказов на клиента" />
          <KpiTile icon={<Hourglass size={15} />} value={fmtDays(s.timeToSecondMedian)} label="до 2-го заказа"
            sub={`среднее ${fmtDays(s.timeToSecondMean)}`} />
          <KpiTile icon={<Timer size={15} />} value={fmtDays(s.timeBetweenMedian)} label="между заказами"
            sub={`среднее ${fmtDays(s.timeBetweenMean)}`} />
        </div>
      </div>
    </div>
  );
}

/** Дорожка времени одного scope: точки-этапы на градиентной линии. */
function TouchLane({ t }: { t: RepeatTouchStats }) {
  const steps = [
    { icon: <Zap size={13} />, label: 'Первое касание', value: fmtMinutes(t.firstTouchMedian) },
    { icon: <PhoneCall size={13} />, label: 'Успешное касание', value: fmtMinutes(t.successfulTouchMedian) },
    { icon: <Truck size={13} />, label: 'Заявка → отгрузка', value: fmtDays(t.cycleTimeMedian) },
    { icon: <CalendarClock size={13} />, label: 'Возраст сделки', value: fmtDays(t.dealAgeMedian) },
  ];
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="text-sm font-semibold text-[var(--color-text)]">{SCOPE_LABEL[t.scope]}</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          дозвон с 1 раза <b className="text-[var(--color-text)] tabular-nums">{fmtPct(t.firstCallSuccessRate)}</b>
        </span>
      </div>
      <div className="relative">
        <div className="absolute left-3 right-3 top-[13px] h-0.5 rounded
          bg-[linear-gradient(90deg,color-mix(in_srgb,var(--color-accent)_65%,transparent),color-mix(in_srgb,var(--color-accent)_10%,transparent))]" />
        <div className="relative grid grid-cols-4 gap-1">
          {steps.map(st => (
            <div key={st.label} className="flex flex-col items-center text-center min-w-0">
              <span className="grid place-items-center w-7 h-7 rounded-full border border-[var(--color-border)]
                bg-[var(--color-bg-surface)] text-[var(--color-accent)] z-10">{st.icon}</span>
              <span className="mt-1.5 text-[13px] font-bold tabular-nums text-[var(--color-text)]">{st.value}</span>
              <span className="text-[9.5px] leading-tight text-[var(--color-text-muted)]">{st.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const MEDALS = ['🥇', '🥈', '🥉'];
/** Подиум топ-3 по Repeat Rate — среди менеджеров с 20+ клиентами, иначе на
 *  пьедестале оказываются люди с двумя клиентами и «50 %». */
function Podium({ rows }: { rows: RepeatManagerRow[] }) {
  const top = rows.filter(r => r.clients >= 20 && r.repeatRate !== null)
    .sort((a, b) => (b.repeatRate ?? 0) - (a.repeatRate ?? 0)).slice(0, 3);
  if (top.length < 3) return null;
  return (
    <div className="grid gap-2 sm:gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
      {top.map((r, i) => (
        <div key={r.managerId} className={`rounded-xl border px-3.5 py-3 flex items-center gap-3 bg-[var(--color-bg-surface)]
          ${i === 0 ? 'border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]' : 'border-[var(--color-border)]'}`}>
          <span className="text-2xl">{MEDALS[i]}</span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[var(--color-text)] truncate">{r.managerName}</span>
            <span className="block text-[11px] text-[var(--color-text-muted)] truncate">
              {fmtPct(r.repeatRate)} · {fmtInt(r.repeatClients)} из {fmtInt(r.clients)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

type SortKey = 'clients' | 'repeatClients' | 'repeatRate' | 'complexRate';

function ManagerTable({ rows }: { rows: RepeatManagerRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('clients');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = a[sortKey] ?? -1, bv = b[sortKey] ?? -1;
    return dir === 'desc' ? Number(bv) - Number(av) : Number(av) - Number(bv);
  }), [rows, sortKey, dir]);
  const maxClients = Math.max(1, ...rows.map(r => r.clients));

  function onSort(k: SortKey) {
    if (k === sortKey) setDir(d => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(k); setDir('desc'); }
  }
  const Th = ({ k, children, className = '' }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={`text-right font-semibold py-2 px-3 select-none cursor-pointer whitespace-nowrap ${className}`}
      onClick={() => onSort(k)}>
      {children}{sortKey === k ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 mb-1">
        <Trophy size={15} className="text-[var(--color-accent)]" />
        <span className="text-sm font-semibold text-[var(--color-text)]">Repeat Rate по менеджерам</span>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
        Клиент относится к менеджеру первой отгрузки. Повторный = 2+ отгрузки, комплексный = 2+ товарные группы.
        Сортировка — кликом по заголовку.
      </p>
      <div className="scroll-x">
        <table className="w-full text-sm border-collapse min-w-[620px]">
          <thead>
            <tr className="text-[var(--color-text-muted)] text-xs uppercase tracking-wide">
              <th className="text-left font-semibold py-2 pr-3">Менеджер</th>
              <th className="text-left font-semibold py-2 px-3 hidden sm:table-cell">Отдел</th>
              <Th k="clients">Клиентов</Th>
              <Th k="repeatClients">Повторных</Th>
              <Th k="repeatRate">Repeat Rate</Th>
              <Th k="complexRate" className="pl-3">Комплексных</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.managerId} className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors">
                <td className="py-2 pr-3 text-[var(--color-text)] font-medium">{r.managerName}</td>
                <td className="py-2 px-3 text-[var(--color-text-muted)] hidden sm:table-cell">{r.departmentName ?? '—'}</td>
                <td className="py-2 px-3 text-right tabular-nums">
                  {/* бар «сколько клиентов» относительно лидера — масштаб виден без чтения чисел */}
                  <span className="inline-block relative min-w-[64px] text-right">
                    <span className="absolute inset-y-0 right-0 rounded-sm opacity-15 bg-[var(--color-accent)]"
                      style={{ width: `${(r.clients / maxClients) * 100}%` }} />
                    <span className="relative pr-1">{fmtInt(r.clients)}</span>
                  </span>
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtInt(r.repeatClients)}</td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">
                    <span className="inline-block w-14 h-1.5 rounded-full bg-[color-mix(in_srgb,var(--color-border)_60%,transparent)] overflow-hidden">
                      <span className="block h-full rounded-full bg-[var(--color-accent)]"
                        style={{ width: `${Math.min(100, r.repeatRate ?? 0)}%` }} />
                    </span>
                    {fmtPct(r.repeatRate)}
                  </span>
                </td>
                <td className="py-2 pl-3 text-right tabular-nums">{fmtPct(r.complexRate)}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={6} className="py-4 text-center text-[var(--color-text-muted)]">Нет данных</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
          <div className="h-3 w-40 bg-[var(--color-border)] rounded animate-pulse mb-4" />
          <div className="h-28 bg-[var(--color-border)] rounded animate-pulse opacity-50" />
        </div>
      ))}
    </div>
  );
}

export function RepeatReportPage() {
  const { data, isLoading, isError } = useQuery<RepeatReport>({
    queryKey: ['repeat-report'],
    queryFn: async () => {
      const res = await fetch('/api/reports/repeat');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <div className="flex flex-col h-full overflow-y-auto overflow-x-hidden bg-[var(--color-bg)]">
      <div className="px-4 py-3 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex items-baseline justify-between gap-3 sticky top-0 z-10">
        <h1 className="text-sm font-semibold text-[var(--color-text)]">Повторные</h1>
        <span className="text-xs text-[var(--color-text-muted)]">
          {data && `Обновлено: ${new Date(data.updatedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
        </span>
      </div>

      <div className="flex-1 px-3 sm:px-4 py-4 flex flex-col gap-4 mx-auto w-full" style={{ maxWidth: 'var(--summary-col, 1200px)' }}>
        {isLoading && <Skeleton />}

        {isError && (
          <div className="rounded-xl border border-[var(--color-negative)]/30 bg-[var(--color-negative)]/10 px-5 py-4">
            <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить отчёт «Повторные».</p>
          </div>
        )}

        {data && (
          <>
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))' }}>
              {data.segments.map(s => <SegmentHero key={s.segment} s={s} />)}
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2 px-1">
                Касания и цикл сделки — медианы
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}>
                {data.touch.map(t => <TouchLane key={t.scope} t={t} />)}
              </div>
            </div>

            <Podium rows={data.byManager} />
            <ManagerTable rows={data.byManager} />
          </>
        )}
      </div>
    </div>
  );
}
