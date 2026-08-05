'use client';
// «Кошелёк» (правка владельца 05.08, этап 3 ЛК-соцсетки): все финансы менеджера
// в одном разделе по образцу банковского приложения — балансы, обмен ₽→MLT и
// вывод в ЗП, переводы коллегам, график «от чего сколько начисляется» и полная
// выписка. Данные — те же две ручки, что уже кормят профиль/награды
// (useShelfQuery + useProfileExtra), своего API у раздела нет.
import { useMemo } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts';
import { useShelfQuery } from '@/features/badges/ui/BadgeShelf';
import {
  useProfileExtra, BalancePill, RubPill, RubWalletBlock, TransferBlock, LedgerSection,
  type LedgerRow,
} from '@/features/manager-card/ui/ManagerTabs';

// Категории графика начислений: только ПРИХОД (amount > 0), сгруппированный по
// понятным человеку источникам. Списания в график сознательно не мешаем —
// «сколько зарабатываю и на чём» читается чище без расходов.
const INCOME_GROUPS: { key: string; label: string; color: string; sources: string[] }[] = [
  { key: 'awards', label: 'Награды', color: '#1c7ed6', sources: ['auto'] },
  { key: 'bonus', label: 'Поощрения', color: '#2f9e44', sources: ['manual_bonus'] },
  { key: 'gacha', label: 'Колесо фортуны', color: '#9c36b5', sources: ['gacha_prize'] },
  { key: 'transfers', label: 'Переводы', color: '#e8590c', sources: ['transfer_in'] },
  { key: 'other', label: 'Прочее', color: '#868e96', sources: ['convert', 'release_zero', 'release_grant', 'shop_refund'] },
];

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' });
}

function buildIncomeChart(ledger: LedgerRow[]) {
  const bySource = new Map(INCOME_GROUPS.flatMap(g => g.sources.map(s => [s, g.key] as const)));
  const months = new Map<string, Record<string, number>>();
  for (const r of ledger) {
    if (r.amount <= 0 || r.reversal_of !== null) continue;
    const group = bySource.get(r.source);
    if (!group) continue;
    const ym = r.date.slice(0, 7);
    const row = months.get(ym) ?? {};
    row[group] = (row[group] ?? 0) + r.amount;
    months.set(ym, row);
  }
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([ym, row]) => ({ month: monthLabel(ym), ...row }));
}

export function WalletTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const { data: shelfData } = useShelfQuery(isSelf ? undefined : managerId);
  const { data: extra } = useProfileExtra(managerId, isSelf);
  const currencyName = shelfData?.currencyName ?? 'MLT';
  const balance = shelfData?.balance ?? 0;
  const ledger = extra?.ledger ?? [];
  const chart = useMemo(() => buildIncomeChart(ledger), [ledger]);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* ══ Балансы ══ */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Балансы</div>
        <div className="flex flex-wrap items-center gap-3">
          <BalancePill balance={balance} currencyName={currencyName} big />
          <RubPill balance={extra?.rubBalance ?? 0} big />
        </div>
        {extra?.expiring && extra.expiring.amount > 0 && (
          <div className="mt-2.5 text-xs" style={{ color: '#e8590c' }}>
            🔥 {extra.expiring.amount.toLocaleString('ru-RU')} {currencyName} сгорит
            {extra.expiring.days === 0 ? ' ближайшей ночью' : ` через ${extra.expiring.days} дн.`} — успейте потратить
          </div>
        )}
      </section>

      {/* ══ Операции (только свой кошелёк) ══ */}
      {isSelf && (
        <>
          <RubWalletBlock managerId={managerId} isSelf={isSelf} extra={extra} currencyName={currencyName} />
          <TransferBlock balance={balance} currencyName={currencyName} />
        </>
      )}

      {/* ══ График начислений ══ */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-1 flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-bold text-[var(--color-text)]">📈 Начисления по месяцам</h3>
          <span className="text-[11px] text-[var(--color-text-muted)]">только приход, по источникам (последние 6 месяцев выписки)</span>
        </div>
        {chart.length === 0 ? (
          <div className="py-6 text-sm text-[var(--color-text-muted)]">Пока нечего показать — начисления появятся с первыми наградами.</div>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: 'var(--color-bg-hover)' }}
                  contentStyle={{
                    backgroundColor: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)',
                    borderRadius: 12, fontSize: 12, color: 'var(--color-text)',
                  }}
                  formatter={(v, name) => [`${Math.round(Number(v ?? 0)).toLocaleString('ru-RU')} ${currencyName}`, String(name)]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {INCOME_GROUPS.map(g => (
                  <Bar key={g.key} dataKey={g.key} name={g.label} stackId="income" fill={g.color} radius={[3, 3, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* ══ Выписка (переехала из «Наград» целиком, со сторно для админов и
             справочником штрафов — правка владельца 05.08) ══ */}
      <LedgerSection managerId={managerId} isSelf={isSelf} />
    </div>
  );
}
