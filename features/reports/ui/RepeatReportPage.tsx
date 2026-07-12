'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  RepeatReport, RepeatSegmentStats, RepeatTouchStats, RepeatManagerRow,
} from '@/features/reports/engine/repeat';

// Раздел «Повторные» (#1725). Адаптив 375/768: карточки — авто-сетка minmax, таблица
// менеджеров обёрнута в .scroll-x (правило CLAUDE.md проекта). Времена — медиана
// (среднее показываем справочно, мельче).

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
const SCOPE_LABEL: Record<string, string> = { primary: 'Первичные', repeat: 'Повторные', all: 'Все' };

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-4 sm:px-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-3">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-2xl sm:text-3xl font-bold tabular-nums text-[var(--color-text)]">{value}</div>
      <div className="text-xs text-[var(--color-text-muted)] mt-1">{label}</div>
      {sub && <div className="text-[11px] text-[var(--color-text-muted)] opacity-80 mt-0.5">{sub}</div>}
    </div>
  );
}

function SegmentCard({ s }: { s: RepeatSegmentStats }) {
  return (
    <Card title={`Повторные — ${SEG_LABEL[s.segment]}`}>
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        <Stat label="Repeat Rate" value={fmtPct(s.repeatRate)}
          sub={`${fmtInt(s.repeatClients)} из ${fmtInt(s.clients)} клиентов`} />
        <Stat label="Комплексных" value={fmtPct(s.complexRate)}
          sub={`${fmtInt(s.complexClients)} клиентов (2+ группы)`} />
        <Stat label="Заказов на клиента" value={fmtNum(s.avgOrders)} sub="в среднем" />
        <Stat label="До 2-го заказа" value={fmtDays(s.timeToSecondMedian)}
          sub={`медиана · среднее ${fmtDays(s.timeToSecondMean)}`} />
        <Stat label="Между заказами" value={fmtDays(s.timeBetweenMedian)}
          sub={`медиана · среднее ${fmtDays(s.timeBetweenMean)}`} />
      </div>
    </Card>
  );
}

function TouchCard({ touch }: { touch: RepeatTouchStats[] }) {
  return (
    <Card title="Касания и цикл сделки — медианы">
      <div className="scroll-x">
        <table className="w-full text-sm border-collapse min-w-[560px]">
          <thead>
            <tr className="text-[var(--color-text-muted)] text-xs uppercase tracking-wide">
              <th className="text-left font-semibold py-2 pr-3">Сегмент</th>
              <th className="text-right font-semibold py-2 px-3">Первое касание</th>
              <th className="text-right font-semibold py-2 px-3">Успешное касание</th>
              <th className="text-right font-semibold py-2 px-3">Дозвон с 1 раза</th>
              <th className="text-right font-semibold py-2 px-3">Цикл до отгрузки</th>
              <th className="text-right font-semibold py-2 pl-3">Возраст сделки</th>
            </tr>
          </thead>
          <tbody>
            {touch.map(t => (
              <tr key={t.scope} className="border-t border-[var(--color-border)]">
                <td className="py-2 pr-3 text-[var(--color-text)] font-medium">{SCOPE_LABEL[t.scope]}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtMinutes(t.firstTouchMedian)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtMinutes(t.successfulTouchMedian)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtPct(t.firstCallSuccessRate)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtDays(t.cycleTimeMedian)}</td>
                <td className="py-2 pl-3 text-right tabular-nums">{fmtDays(t.dealAgeMedian)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ManagerTable({ rows }: { rows: RepeatManagerRow[] }) {
  return (
    <Card title="Repeat Rate по менеджерам">
      <p className="text-[11px] text-[var(--color-text-muted)] mb-3 -mt-1">
        Клиент относится к менеджеру первой отгрузки. Повторный = 2+ отгрузки, комплексный = 2+ товарные группы.
      </p>
      <div className="scroll-x">
        <table className="w-full text-sm border-collapse min-w-[560px]">
          <thead>
            <tr className="text-[var(--color-text-muted)] text-xs uppercase tracking-wide">
              <th className="text-left font-semibold py-2 pr-3">Менеджер</th>
              <th className="text-left font-semibold py-2 px-3 hidden sm:table-cell">Отдел</th>
              <th className="text-right font-semibold py-2 px-3">Клиентов</th>
              <th className="text-right font-semibold py-2 px-3">Повторных</th>
              <th className="text-right font-semibold py-2 px-3">Repeat Rate</th>
              <th className="text-right font-semibold py-2 pl-3">Комплексных</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.managerId} className="border-t border-[var(--color-border)]">
                <td className="py-2 pr-3 text-[var(--color-text)] font-medium">{r.managerName}</td>
                <td className="py-2 px-3 text-[var(--color-text-muted)] hidden sm:table-cell">{r.departmentName ?? '—'}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtInt(r.clients)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtInt(r.repeatClients)}</td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtPct(r.repeatRate)}</td>
                <td className="py-2 pl-3 text-right tabular-nums">{fmtPct(r.complexRate)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="py-4 text-center text-[var(--color-text-muted)]">Нет данных</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
          <div className="h-3 w-40 bg-[var(--color-border)] rounded animate-pulse mb-4" />
          <div className="h-24 bg-[var(--color-border)] rounded animate-pulse opacity-50" />
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
    <div className="flex flex-col h-full overflow-auto bg-[var(--color-bg)]">
      <div className="px-4 py-3 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex items-baseline justify-between gap-3 sticky top-0 z-10">
        <h1 className="text-sm font-semibold text-[var(--color-text)]">Повторные</h1>
        <span className="text-xs text-[var(--color-text-muted)]">
          {data && `Обновлено: ${new Date(data.updatedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
        </span>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-4 mx-auto w-full" style={{ maxWidth: 'var(--summary-col, 1200px)' }}>
        {isLoading && <Skeleton />}

        {isError && (
          <div className="rounded-xl border border-[var(--color-negative)]/30 bg-[var(--color-negative)]/10 px-5 py-4">
            <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить отчёт «Повторные».</p>
          </div>
        )}

        {data && (
          <>
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
              {data.segments.map(s => <SegmentCard key={s.segment} s={s} />)}
            </div>
            <TouchCard touch={data.touch} />
            <ManagerTable rows={data.byManager} />
          </>
        )}
      </div>
    </div>
  );
}
