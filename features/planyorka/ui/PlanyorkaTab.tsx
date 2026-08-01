'use client';
// Таб «Планёрка» (задача владельца 01.08, одобрено Серёгой): текстовая сводка
// менеджера — «где деньги, что делать, где рост, где падение» — собранная
// ШАБЛОНАМИ из данных (features/planyorka/engine/planyorka.ts), без LLM. Каждая
// цифра — клик в соответствующий список (переключение таба ЛК, best-effort
// пред-фильтр там, где список это поддерживает).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Filter as CustomerFilter } from '@/features/customers/ui/CustomersTab';
import { isWithinFirstWorkingWeek } from '@/lib/metrics/productionCalendar';
import { toZonedTime } from 'date-fns-tz';

// Дефолт периода (правка владельца 01.08, тот же механизм, что lib/period.defaultPeriod):
// в первую рабочую неделю месяца открывать сразу ПРОШЛЫЙ месяц (offset=-1) — в
// первых числах текущего почти нет данных сравнивать не с чем. Явный клик
// пользователя по стрелкам/табам периода эту функцию больше не вызывает.
// МСК-зонирование — как в msk() (lib/period/index.ts): isWithinFirstWorkingWeek
// читает getFullYear/getMonth/getDate как локальные, значит дату нужно зонировать.
function defaultMonthOffset(): number {
  return isWithinFirstWorkingWeek(toZonedTime(new Date(), 'Europe/Moscow')) ? -1 : 0;
}

interface GroupDelta { group: string; amount: number; prevAmount: number; delta: number; deltaPct: number | null }
interface PotentialItem { kind: 'open_deal' | 'expected_repeat'; label: string; amount: number; probability: number; clientKey?: string }
interface PlanyorkaData {
  unit: 'day' | 'week' | 'month';
  period: { fromStr: string; toStr: string };
  compare: { fromStr: string; toStr: string };
  totals: { salesCount: number; salesAmount: number; bookingsCount: number; bookingsAmount: number; shipmentsCount: number; shipmentsAmount: number };
  prevTotals: PlanyorkaData['totals'];
  groupDeltas: { rising: GroupDelta[]; falling: GroupDelta[] };
  potential: { totalMid: number; totalLow: number; totalHigh: number; fromOpenDeals: number; fromExpectedRepeat: number; items: PotentialItem[] };
  missed: { refusedSum: number; refusedCount: number; cutoffSum: number; cutoffCount: number; noCallBookingsSum: number; noCallBookingsCount: number; total: number };
  bookingCallStat: { total: number; withCall: number; withoutCall: number; withCallPct: number | null };
  moneyActions: { key: string; label: string; amount: number; count: number }[];
  plan: { planSales: number | null; salesAmount: number; toGoal: number | null };
}

const UNIT_LABELS: Record<PlanyorkaData['unit'], string> = { day: 'День', week: 'Неделя', month: 'Месяц' };

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ₽`;
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
}
function fmtDelta(pct: number | null): { text: string; arrow: string; color: string } {
  if (pct === null) return { text: '—', arrow: '', color: 'var(--color-text-muted)' };
  const arrow = pct > 0.5 ? '▲' : pct < -0.5 ? '▼' : '→';
  const color = pct > 0.5 ? 'var(--color-positive, #2f9e44)' : pct < -0.5 ? 'var(--color-negative, #e03131)' : 'var(--color-text-muted)';
  return { text: `${pct > 0 ? '+' : ''}${pct.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%`, arrow, color };
}

function useFn(managerId: string, isSelf: boolean, unit: PlanyorkaData['unit'], offset: number) {
  return useQuery<PlanyorkaData>({
    queryKey: ['planyorka', isSelf ? 'me' : managerId, unit, offset],
    queryFn: async () => {
      const qs = new URLSearchParams({ unit, offset: String(offset) });
      if (!isSelf) qs.set('bitrixId', managerId);
      const res = await fetch(`/api/planyorka?${qs.toString()}`);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

function Num({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  if (!onClick) return <b className="text-[var(--color-text)]">{children}</b>;
  return (
    <button type="button" onClick={onClick}
      className="font-bold text-[var(--color-accent)] hover:underline underline-offset-2">
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</div>
      {children}
    </section>
  );
}

export function PlanyorkaTab({ managerId, isSelf, onGoCustomers, onGoStats }: {
  managerId: string; isSelf: boolean;
  onGoCustomers: (filter?: CustomerFilter, category?: string) => void;
  onGoStats: () => void;
}) {
  const [unit, setUnit] = useState<PlanyorkaData['unit']>('month');
  const [offset, setOffset] = useState<number>(() => defaultMonthOffset());
  const { data, isLoading, error } = useFn(managerId, isSelf, unit, offset);

  const salesDelta = data ? fmtDelta(data.prevTotals.salesAmount > 0
    ? ((data.totals.salesAmount - data.prevTotals.salesAmount) / data.prevTotals.salesAmount) * 100 : null) : null;
  const bookingsDelta = data ? fmtDelta(data.prevTotals.bookingsCount > 0
    ? ((data.totals.bookingsCount - data.prevTotals.bookingsCount) / data.prevTotals.bookingsCount) * 100 : null) : null;
  const shipDelta = data ? fmtDelta(data.prevTotals.shipmentsAmount > 0
    ? ((data.totals.shipmentsAmount - data.prevTotals.shipmentsAmount) / data.prevTotals.shipmentsAmount) * 100 : null) : null;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* Переключатель периода (п.6 брифа): месяц/неделя/день, offset назад */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1">
          {(['month', 'week', 'day'] as const).map(u => (
            <button key={u} type="button" onClick={() => { setUnit(u); setOffset(u === 'month' ? defaultMonthOffset() : 0); }}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                unit === u ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
              }`}>
              {UNIT_LABELS[u]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setOffset(o => Math.max(-11, o - 1))}
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)]">←</button>
          <span className="min-w-[140px] text-center text-xs text-[var(--color-text-muted)]">
            {data ? `${data.period.fromStr.split('-').reverse().join('.')} – ${data.period.toStr.split('-').reverse().join('.')}` : '…'}
          </span>
          <button type="button" onClick={() => setOffset(o => Math.min(0, o + 1))} disabled={offset >= 0}
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)] disabled:opacity-30">→</button>
        </div>
      </div>

      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Считаю планёрку…</div>}
      {error && <div className="text-sm text-[var(--color-negative,#e03131)]">{error instanceof Error ? error.message : 'Ошибка'}</div>}

      {data && (<>
        {/* Блок 1: итоги периода vs предыдущий */}
        <Section title={`Итоги · ${UNIT_LABELS[data.unit].toLowerCase()} vs предыдущий ${UNIT_LABELS[data.unit].toLowerCase()}`}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {[
              { label: 'Продажи', count: data.totals.salesCount, amount: data.totals.salesAmount, d: salesDelta },
              { label: 'Брони', count: data.totals.bookingsCount, amount: data.totals.bookingsAmount, d: bookingsDelta },
              { label: 'Отгрузки', count: data.totals.shipmentsCount, amount: data.totals.shipmentsAmount, d: shipDelta },
            ].map(row => (
              <div key={row.label} className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
                <div className="text-[11px] text-[var(--color-text-muted)]">{row.label}</div>
                <div className="text-lg font-extrabold text-[var(--color-text)] whitespace-nowrap">
                  <Num onClick={onGoStats}>{row.count}</Num> шт · {fmtMoney(row.amount)}
                </div>
                {row.d && (
                  <div className="text-xs font-semibold" style={{ color: row.d.color }}>{row.d.arrow} {row.d.text}</div>
                )}
              </div>
            ))}
          </div>
          {(data.groupDeltas.rising.length > 0 || data.groupDeltas.falling.length > 0) && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[11px] font-bold text-[var(--color-positive,#2f9e44)]">Где рост</div>
                {data.groupDeltas.rising.length === 0 && <div className="text-xs text-[var(--color-text-muted)]">роста нет</div>}
                {data.groupDeltas.rising.map(g => (
                  <div key={g.group} className="text-[13px] flex justify-between gap-2">
                    <span className="truncate text-[var(--color-text)]">{g.group}</span>
                    <span className="font-semibold text-[var(--color-positive,#2f9e44)] whitespace-nowrap">+{fmtMoney(g.delta)}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="mb-1 text-[11px] font-bold text-[var(--color-negative,#e03131)]">Где падение</div>
                {data.groupDeltas.falling.length === 0 && <div className="text-xs text-[var(--color-text-muted)]">падений нет</div>}
                {data.groupDeltas.falling.map(g => (
                  <div key={g.group} className="text-[13px] flex justify-between gap-2">
                    <span className="truncate text-[var(--color-text)]">{g.group}</span>
                    <span className="font-semibold text-[var(--color-negative,#e03131)] whitespace-nowrap">{fmtMoney(g.delta)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* Блок 2: потенциал / факт / упущенное */}
        <Section title="Потенциал / Факт / Упущенное">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
              <div className="text-[11px] text-[var(--color-text-muted)]">Факт (продано)</div>
              <div className="text-lg font-extrabold text-[var(--color-text)]">{fmtMoney(data.totals.salesAmount)}</div>
            </div>
            <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
              <div className="text-[11px] text-[var(--color-text-muted)]" title="Открытые сделки × вероятность продажи (модель offload) + ожидаемая повторка у клиентов, вышедших за свой цикл">
                Потенциал (диапазон ±25%)
              </div>
              <div className="text-lg font-extrabold text-[var(--color-accent)]">
                {fmtMoney(data.potential.totalLow)} – {fmtMoney(data.potential.totalHigh)}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">центр {fmtMoney(data.potential.totalMid)}</div>
            </div>
            <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
              <div className="text-[11px] text-[var(--color-text-muted)]">Упущенное</div>
              <div className="text-lg font-extrabold text-[var(--color-negative,#e03131)]">{fmtMoney(data.missed.total)}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                отказы {fmtMoney(data.missed.refusedSum)} · за отсечкой {fmtMoney(data.missed.cutoffSum)} · брони без звонка {fmtMoney(data.missed.noCallBookingsSum)}
              </div>
            </div>
          </div>
          {data.potential.items.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-[var(--color-accent)]">
                Из чего сложился потенциал ({data.potential.items.length}) →
              </summary>
              <div className="mt-2 flex flex-col gap-1">
                {data.potential.items.slice(0, 10).map((it, i) => (
                  <div key={i} className="flex justify-between gap-2 text-[13px] border-t border-[var(--color-border)] py-1 first:border-t-0">
                    <span className="truncate text-[var(--color-text)]">{it.label}</span>
                    <span className="whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">
                      {fmtMoney(it.amount)} × {(it.probability * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Section>

        {/* Блок 3: где деньги — топ-3 действия */}
        <Section title="Где деньги — что делать сначала">
          {data.moneyActions.length === 0 ? (
            <div className="text-sm text-[var(--color-text-muted)]">Горящих действий нет — всё под контролем.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {data.moneyActions.map((a, i) => (
                <div key={a.key} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-accent)] text-[11px] font-bold text-[var(--color-text-inverse)]">{i + 1}</span>
                    <Num onClick={() => {
                      if (a.key === 'no_call_bookings') onGoCustomers('active');
                      else if (a.key === 'key_at_risk') onGoCustomers('overdue', 'key');
                      else onGoCustomers('overdue');
                    }}>{a.label}</Num>
                  </div>
                  <span className="whitespace-nowrap font-bold text-[var(--color-text)]">{fmtMoney(a.amount)}</span>
                </div>
              ))}
              {data.plan.planSales !== null && data.plan.toGoal !== null && (
                <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">
                  До плана осталось <b className="text-[var(--color-text)]">{fmtMoney(data.plan.toGoal)}</b>
                  {' '}при живом потенциале <b className="text-[var(--color-accent)]">{fmtMoney(data.potential.totalMid)}</b>
                  {data.potential.totalMid >= data.plan.toGoal ? ' — план достижим' : ' — потенциала может не хватить'}
                </div>
              )}
            </div>
          )}
        </Section>

        {/* Блок 4: акцент броней */}
        <Section title="Брони">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="text-3xl font-extrabold text-[var(--color-text)]">
              {data.bookingCallStat.withCallPct !== null ? `${data.bookingCallStat.withCallPct.toFixed(0)}%` : '—'}
            </div>
            <div className="text-[13px] text-[var(--color-text-muted)]">
              со звонком: <Num onClick={() => onGoCustomers('active')}>{data.bookingCallStat.withCall}</Num> ·
              {' '}без звонка: <Num onClick={() => onGoCustomers('active')}>{data.bookingCallStat.withoutCall}</Num>
              {' '}из {data.bookingCallStat.total} активных броней
            </div>
          </div>
        </Section>
      </>)}
    </div>
  );
}

// ── РОП: агрегат «Планёрка команды» ──────────────────────────────────────────

interface TeamRow {
  bitrixId: number; name: string; salesAmount: number; salesDeltaPct: number | null;
  noCallBookingsCount: number; noCallBookingsSum: number; potentialMid: number; missedTotal: number; keyAtRiskCount: number;
}

export function TeamPlanyorkaBlock({ onOpenManager }: { onOpenManager?: (id: number) => void }) {
  const [unit, setUnit] = useState<'month' | 'week' | 'day'>('month');
  const [offset, setOffset] = useState<number>(() => defaultMonthOffset());
  const { data, isLoading } = useQuery<{ team: TeamRow[] }>({
    queryKey: ['planyorka-team', unit, offset],
    queryFn: async () => {
      const res = await fetch(`/api/planyorka/team?unit=${unit}&offset=${offset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const team = data?.team ?? [];
  if (!isLoading && team.length === 0) return null;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-2.5 flex items-center gap-3 flex-wrap">
        <h2 className="text-base font-bold text-[var(--color-text)]">Планёрка команды</h2>
        <div className="flex gap-1 rounded-xl border border-[var(--color-border)] p-0.5">
          {(['month', 'week', 'day'] as const).map(u => (
            <button key={u} type="button" onClick={() => { setUnit(u); setOffset(u === 'month' ? defaultMonthOffset() : 0); }}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${unit === u ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
              {UNIT_LABELS[u]}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? (
        <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <th className="py-1.5 pr-3 font-bold">Менеджер</th>
                <th className="py-1.5 pr-3 text-right font-bold">Продажи</th>
                <th className="py-1.5 pr-3 text-right font-bold">Брони без звонка</th>
                <th className="py-1.5 pr-3 text-right font-bold">Потенциал</th>
                <th className="py-1.5 pr-3 text-right font-bold">Упущенное</th>
                <th className="py-1.5 text-right font-bold">🔑⚠</th>
              </tr>
            </thead>
            <tbody>
              {team.map(r => {
                const d = fmtDelta(r.salesDeltaPct);
                return (
                  <tr key={r.bitrixId} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-3">
                      {/* «клик по менеджеру — его планёрка» (п.5 брифа): переход на его карточку. */}
                      <a href={onOpenManager ? undefined : `/manager/${r.bitrixId}`}
                        onClick={onOpenManager ? () => onOpenManager(r.bitrixId) : undefined}
                        className="font-semibold text-[var(--color-accent)] hover:underline cursor-pointer">{r.name}</a>
                    </td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                      {fmtMoney(r.salesAmount)} <span style={{ color: d.color }}>{d.arrow}{d.text !== '—' ? ` ${d.text}` : ''}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{r.noCallBookingsCount} шт · {fmtMoney(r.noCallBookingsSum)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap text-[var(--color-accent)] font-semibold">{fmtMoney(r.potentialMid)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap text-[var(--color-negative,#e03131)]">{fmtMoney(r.missedTotal)}</td>
                    <td className="py-1.5 text-right font-bold">{r.keyAtRiskCount > 0 ? r.keyAtRiskCount : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
