'use client';
// План/факт-полоса ЛК («Карточка 10.0»): Сегодня · Неделя · Месяц — по образцу
// Bitrix-приложения владельца (marketplace/app/52), но живое: прогресс к плану,
// брони/подтв./отгрузки/звонки. Не зависит от периода фильтров карточки — это
// всегда «прямо сейчас» (день/неделя/месяц по МСК), как в референсе.
import { useQuery } from '@tanstack/react-query';
import { NoData } from '@/components/ui/NoData';
import type { PlanFactResult, PlanFactBucket } from '@/features/manager-card/engine/planFact';

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ₽`;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}
function fmtPctOfPlan(fact: number, plan: number | null): string | null {
  if (plan === null || plan <= 0) return null;
  return `${Math.round((fact / plan) * 100)}%`;
}
function fmtDateRu(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

function ProgressBar({ fact, plan }: { fact: number; plan: number | null }) {
  if (plan === null || plan <= 0) return null;
  const pct = Math.min(100, (fact / plan) * 100);
  const done = fact >= plan;
  return (
    <div className="h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden mt-1">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: done ? 'var(--color-positive, #2f9e44)' : 'var(--color-accent)' }}
      />
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[12px] text-[var(--color-text-muted)]">{label}</span>
      <span className="text-[13px] font-semibold text-[var(--color-text)] tabular-nums text-right">
        {value}
        {sub && <span className="ml-1 font-normal text-[var(--color-text-muted)]">{sub}</span>}
      </span>
    </div>
  );
}

function BucketCard({ title, subtitle, b, extras }: {
  title: string; subtitle: string; b: PlanFactBucket;
  extras?: { primarySalesAmount: number; repeatSalesAmount: number; repeatSharePct: number | null; convDealToSalePct: number | null };
}) {
  const planPct = fmtPctOfPlan(b.salesAmount, b.planSales);
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-3.5 min-w-0">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <div>
          <span className="text-[13px] font-extrabold text-[var(--color-text)]">{title}</span>
          <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">{subtitle}</span>
        </div>
        {planPct && (
          <span
            className="text-[12px] font-extrabold px-2 py-0.5 rounded-full shrink-0"
            style={{
              color: b.salesAmount >= (b.planSales ?? 0) ? 'var(--color-positive, #2f9e44)' : 'var(--color-accent)',
              backgroundColor: `color-mix(in srgb, ${b.salesAmount >= (b.planSales ?? 0) ? 'var(--color-positive, #2f9e44)' : 'var(--color-accent)'} 12%, transparent)`,
            }}
          >
            {planPct}
          </span>
        )}
      </div>

      <div className="pb-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] text-[var(--color-text-muted)]">Продажи</span>
          <span className="text-[15px] font-extrabold text-[var(--color-text)] tabular-nums">
            {fmtMoney(b.salesAmount)}
            {b.planSales !== null && <span className="text-[11px] font-normal text-[var(--color-text-muted)]"> / {fmtMoney(b.planSales)}</span>}
          </span>
        </div>
        <ProgressBar fact={b.salesAmount} plan={b.planSales} />
      </div>

      <Row label="Кол-во продаж" value={b.salesCount} />
      <Row label="Брони" value={b.reservationsCount} sub={b.reservationsAmount > 0 ? `· ${fmtMoney(b.reservationsAmount)}` : undefined} />
      <Row label="Подтв. брони" value={b.confirmedCount} />

      <div className="pt-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] text-[var(--color-text-muted)]">Отгружено</span>
          <span className="text-[13px] font-bold text-[var(--color-text)] tabular-nums">
            {fmtMoney(b.shipmentsAmount)}
            {b.planShipments !== null && <span className="text-[11px] font-normal text-[var(--color-text-muted)]"> / {fmtMoney(b.planShipments)}</span>}
          </span>
        </div>
        <ProgressBar fact={b.shipmentsAmount} plan={b.planShipments} />
      </div>

      {extras && (
        <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
          <Row label="Продажи (перв.)" value={fmtMoney(extras.primarySalesAmount)} />
          <Row label="Продажи (повт.)" value={fmtMoney(extras.repeatSalesAmount)} />
          <Row label="% повторных" value={extras.repeatSharePct !== null ? `${extras.repeatSharePct.toFixed(1).replace('.', ',')}%` : '—'} />
          <Row label="CR сделка → продажа" value={extras.convDealToSalePct !== null ? `${extras.convDealToSalePct.toFixed(1).replace('.', ',')}%` : '—'} />
        </div>
      )}

      <div className="mt-2 pt-2 border-t border-[var(--color-border)] flex items-center justify-between text-[11.5px] text-[var(--color-text-muted)]">
        <span>Звонки исходящие: <b className="text-[var(--color-text)]">{b.callsOut}</b></span>
        <span>разговоры: <b className="text-[var(--color-text)]">{b.callMinutes} мин</b></span>
      </div>
    </div>
  );
}

// Общий хук: полоса и кнопка «Копировать для отчёта» читают одни данные —
// React Query дедуплицирует по ключу, запрос уходит один.
export function usePlanFact(managerId: string, mode: 'manager' | 'department') {
  return useQuery({
    queryKey: ['manager-card-plan-fact', mode, managerId],
    queryFn: async () => {
      const body = mode === 'department' ? { mode, departmentId: managerId } : { managerId };
      const res = await fetch('/api/manager-card/plan-fact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Ошибка план/факта');
      return res.json() as Promise<PlanFactResult>;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000, // «прямо сейчас»-блок — держим свежим, пока страница открыта
  });
}

export function PlanFactStrip({ managerId, mode }: { managerId: string; mode: 'manager' | 'department' }) {
  const { data, isLoading, error } = usePlanFact(managerId, mode);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5">
        {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-56 bg-[var(--color-border)] rounded-2xl animate-pulse" />)}
      </div>
    );
  }
  if (error || !data) {
    return <div className="text-sm text-[var(--color-text-muted)]">План/факт недоступен: {error instanceof Error ? error.message : '—'}</div>;
  }

  // «Нет данных» вместо частокола нулей (правило владельца 05.08): у сотрудника
  // вне продаж (маркетинг, снабжение, логистика, HR — 100+ человек по
  // оргструктуре) ни плана, ни фактов не бывает в принципе, и три карточки с
  // нулями выглядят как «он ничего не продал», а не как «ему нечего продавать».
  const monthEmpty = !data.month.planSales && !data.month.salesAmount
    && !data.month.shipmentsAmount && !data.month.reservationsAmount;
  const weekEmpty = !data.week.salesAmount && !data.week.shipmentsAmount && !data.week.reservationsAmount;
  const dayEmpty = !data.day.salesAmount && !data.day.shipmentsAmount && !data.day.reservationsAmount;
  if (monthEmpty && weekEmpty && dayEmpty) {
    return (
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <NoData what="продаж, отгрузок и планов за период" hint="Похоже, эта роль не участвует в продажах — цифры появятся, если появятся сделки." />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5">
      <BucketCard title="Сегодня" subtitle={fmtDateRu(data.day.fromStr)} b={data.day} />
      <BucketCard title="Неделя" subtitle={`с ${fmtDateRu(data.week.fromStr)}`} b={data.week} />
      <BucketCard title="Месяц" subtitle={`с ${fmtDateRu(data.month.fromStr)}`} b={data.month} extras={data.monthExtras} />
    </div>
  );
}
