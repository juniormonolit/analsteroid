'use client';
import { useQuery } from '@tanstack/react-query';
import { X, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { DateRange } from '@/lib/period';

interface Deal {
  deal_id: number;
  deal_name: string;
  amount: string;
  created_at: string;
  sold_at: string | null;
  delivered_at: string | null;
  reserved_at: string | null;
  stage_name: string | null;
  product_group_name: string | null;
  funnel_name: string | null;
}

interface Props {
  managerId: string;
  managerName: string;
  period: DateRange;
  dealScope: string;
  onClose: () => void;
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  return format(new Date(s), 'd MMM', { locale: ru });
}

function fmtMoney(s: string | null) {
  if (!s) return '—';
  return Number(s).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
}

export function DrilldownDrawer({ managerId, managerName, period, dealScope, onClose }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['deals', managerId, period.from, period.to, dealScope],
    queryFn: () =>
      fetch(
        `/api/reports/deals?managerId=${managerId}&from=${period.from.toISOString()}&to=${period.to.toISOString()}&scope=${dealScope}`
      ).then(r => r.json()),
  });

  const deals: Deal[] = data?.deals ?? [];

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />

      {/* Drawer */}
      <div className="w-full max-w-3xl bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <div>
            <h2 className="font-semibold text-[var(--color-text)]">{managerName}</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {format(period.from, 'd MMM', { locale: ru })} — {format(period.to, 'd MMM yyyy', { locale: ru })}
              {!isLoading && ` · ${deals.length} сделок`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="p-6 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />
              ))}
            </div>
          ) : deals.length === 0 ? (
            <div className="p-6 text-center text-[var(--color-text-muted)] text-sm">Сделок не найдено</div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-[var(--color-table-header)]">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium border-b border-[var(--color-border)] whitespace-nowrap">Сделка</th>
                  <th className="text-left px-3 py-2.5 font-medium border-b border-[var(--color-border)] whitespace-nowrap">Продукт</th>
                  <th className="text-left px-3 py-2.5 font-medium border-b border-[var(--color-border)] whitespace-nowrap">Стадия</th>
                  <th className="text-right px-3 py-2.5 font-medium border-b border-[var(--color-border)] whitespace-nowrap">Сумма</th>
                  <th className="text-right px-3 py-2.5 font-medium border-b border-[var(--color-border)] whitespace-nowrap">Создана</th>
                  <th className="text-right px-3 py-2.5 font-medium border-b border-[var(--color-border)] whitespace-nowrap">Продана</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((deal, i) => (
                  <tr
                    key={deal.deal_id}
                    className={`border-b border-[var(--color-border)] hover:bg-[var(--color-table-row-hover)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <span className="text-[var(--color-text-muted)] text-xs">#{deal.deal_id}</span>
                        <span className="ml-1 truncate max-w-[200px]" title={deal.deal_name}>{deal.deal_name || '—'}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[var(--color-text-muted)] text-xs truncate max-w-[140px]" title={deal.product_group_name ?? ''}>
                      {deal.product_group_name ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">{deal.stage_name ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtMoney(deal.amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--color-text-muted)]">{fmtDate(deal.created_at)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtDate(deal.sold_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
