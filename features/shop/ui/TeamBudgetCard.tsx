'use client';

// Командный бюджет отдела в витрине магазина (задача 11.08).
//
// Карточка отвечает на три вопроса, без которых командные позиции выглядят как
// ошибка ценника:
//   1. почему командное стоит дороже базовой цены — потому что цена растёт от
//      размера отдела, и множитель показан явно;
//   2. чем за него платят — не личным кошельком, а бюджетом отдела;
//   3. откуда бюджет берётся — доля от начислений участников, и видно, кто
//      именно его наполнил.
//
// Третий пункт — не украшение: бюджет общий, и руководитель должен видеть, что
// тратит заработанное командой, а не «выданное сверху».

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, Wallet } from 'lucide-react';
import { MltCoin } from '@/components/icons/MltCoin';

interface Move { amount: number; source: string; who: string | null; comment: string | null; at: string }
interface Payload {
  deptKey: string | null; deptName: string | null; size: number;
  balance: number; sharePct: number; rows: Move[];
}

const SOURCE_LABELS: Record<string, string> = {
  share: 'доля от начисления',
  purchase: 'покупка',
  manual: 'вручную',
};

const fmtAt = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function TeamBudgetCard({ currencyName }: { currencyName: string }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery<Payload>({
    queryKey: ['team-budget'],
    queryFn: async () => {
      const res = await fetch('/api/shop/team-budget');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Не руководитель или отдел не определился — карточки нет вовсе, а не пустая.
  if (!data?.deptKey) return null;
  const mult = 1 + 0.5 * (Math.max(1, data.size) - 1);

  return (
    <section className="mb-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--color-text)]">
          <Wallet size={15} className="text-[var(--color-accent)]" />
          Бюджет отдела{data.deptName ? ` «${data.deptName}»` : ''}
        </span>
        <span className="inline-flex items-center gap-1 text-sm">
          <MltCoin size={14} />
          <b className="tabular-nums">{data.balance.toLocaleString('ru-RU')}</b>
          <span className="text-[var(--color-text-muted)]">{currencyName}</span>
        </span>
        <span className="inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]">
          <Users size={13} /> {data.size} чел. · командная цена ×{mult.toFixed(1).replace('.0', '')}
        </span>
        <button
          type="button" onClick={() => setOpen(v => !v)}
          className="ml-auto min-h-11 rounded-lg px-2 text-[13px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] sm:min-h-8"
        >
          {open ? 'скрыть движения' : 'движения'}
        </button>
      </div>

      <p className="mt-1 text-[11px] leading-snug text-[var(--color-text-muted)]">
        Командные позиции оплачиваются этим бюджетом, а не вашим личным кошельком. Бюджет
        наполняется автоматически: {data.sharePct}% от каждого начисления {currencyName} участникам
        отдела. Цена командной позиции растёт от числа людей — за одну и ту же вещь отдел
        из {data.size} платит ×{mult.toFixed(1).replace('.0', '')} к базовой цене.
      </p>

      {open && (
        <div className="mt-2">
          {data.rows.length === 0 ? (
            <div className="text-[12px] text-[var(--color-text-muted)]">
              Движений пока нет — бюджет начнёт наполняться с ближайших начислений отделу.
            </div>
          ) : (
            <div className="scroll-x">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="text-left text-[var(--color-text-muted)]">
                    <th className="py-1 pr-2 font-medium">Когда</th>
                    <th className="py-1 pr-2 font-medium">Кто</th>
                    <th className="py-1 pr-2 font-medium">За что</th>
                    <th className="py-1 text-right font-medium">Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((m, i) => (
                    <tr key={i} className="border-t border-[var(--color-border)]">
                      <td className="py-1 pr-2 whitespace-nowrap tabular-nums">{fmtAt(m.at)}</td>
                      <td className="py-1 pr-2">{m.who ?? '—'}</td>
                      <td className="py-1 pr-2 text-[var(--color-text-muted)]">
                        {m.comment ?? SOURCE_LABELS[m.source] ?? m.source}
                      </td>
                      <td
                        className="py-1 text-right tabular-nums font-medium"
                        style={{ color: m.amount >= 0 ? '#2f9e44' : 'var(--color-text)' }}
                      >
                        {m.amount >= 0 ? '+' : ''}{Math.round(m.amount * 100) / 100}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
