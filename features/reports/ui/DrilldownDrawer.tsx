'use client';
import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
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
  confirmed_at: string | null;
  manager_id: string;
  manager_name: string;
  stage_name: string | null;
  product_group_display: string;
  funnel_name: string | null;
}

export interface DrilldownTarget {
  id: string;
  name: string;
  metricId?: string;   // which metric cell was clicked (undefined = row click)
}

interface Props {
  target: DrilldownTarget;
  dimensionType: 'manager' | 'product-group';
  period: DateRange;
  dealScope: string;
  productGroupMode: 'kc' | 'by_max';
  onClose: () => void;
}

const METRIC_LABELS: Record<string, string> = {
  primary_deals_count:          'Входящие сделки',
  incoming_deals_count:         'Входящие сделки',
  called_deals_count:           'Прозвоненные',
  reservations_count:           'Бронирования',
  confirmed_reservations_count: 'Подтверждённые бронирования',
  primary_sales_count:          'Продажи (первичные)',
  primary_sales_amount:         'Сумма продаж (первичные)',
  repeat_sales_count:           'Продажи (повторные)',
  repeat_sales_amount:          'Сумма продаж (повторные)',
  primary_shipments_count:      'Отгрузки (первичные)',
  primary_shipments_amount:     'Сумма отгрузок (первичные)',
  repeat_shipments_count:       'Отгрузки (повторные)',
  repeat_shipments_amount:      'Сумма отгрузок (повторные)',
};

const METRIC_DATE_FIELD: Record<string, keyof Deal> = {
  primary_deals_count:          'created_at',
  incoming_deals_count:         'created_at',
  called_deals_count:           'created_at',
  reservations_count:           'reserved_at',
  confirmed_reservations_count: 'confirmed_at',
  primary_sales_count:          'sold_at',
  primary_sales_amount:         'sold_at',
  repeat_sales_count:           'sold_at',
  repeat_sales_amount:          'sold_at',
  primary_shipments_count:      'delivered_at',
  primary_shipments_amount:     'delivered_at',
  repeat_shipments_count:       'delivered_at',
  repeat_shipments_amount:      'delivered_at',
};

function fmt(s: string | null) {
  if (!s) return '—';
  return format(new Date(s), 'd MMM', { locale: ru });
}
function fmtMoney(v: number | string | null) {
  const n = Number(v);
  if (!v || isNaN(n)) return '—';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
}

function GroupSection({
  groupName, deals, defaultOpen, dateField,
}: {
  groupName: string;
  deals: Deal[];
  defaultOpen: boolean;
  dateField: keyof Deal;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const total = deals.reduce((s, d) => s + (Number(d.amount) || 0), 0);

  return (
    <div className="border-b border-[var(--color-border)]">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-5 py-3 text-left hover:bg-[var(--color-table-row-hover)] transition-colors group"
      >
        <span className="text-[var(--color-text-muted)] shrink-0">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="font-medium text-[var(--color-text)] flex-1 min-w-0 truncate">
          {groupName}
        </span>
        <span className="text-xs text-[var(--color-text-muted)] shrink-0 mr-3">
          {deals.length} сд.
        </span>
        <span className="text-sm font-medium tabular-nums shrink-0 text-[var(--color-text)]">
          {fmtMoney(total)}
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto bg-[var(--color-bg)]">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-[var(--color-table-header)]">
                <th className="text-left px-5 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap w-[60px]">#</th>
                <th className="text-left px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap">Сделка</th>
                <th className="text-left px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap">Стадия</th>
                <th className="text-left px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap">Воронка</th>
                <th className="text-right px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap">Сумма</th>
                <th className="text-right px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap">Дата</th>
                <th className="text-right px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap">Продажа</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((deal, i) => (
                <tr
                  key={deal.deal_id}
                  className={`border-t border-[var(--color-border)] hover:bg-[var(--color-table-row-hover)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}
                >
                  <td className="px-5 py-1.5 text-[var(--color-text-muted)]">{deal.deal_id}</td>
                  <td className="px-3 py-1.5 max-w-[320px]">
                    <a
                      href={`https://td.monolit-crm.ru/crm/deal/details/${deal.deal_id}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate hover:text-[var(--color-accent)] hover:underline transition-colors"
                      title={deal.deal_name}
                    >
                      {deal.deal_name || '—'}
                    </a>
                  </td>
                  <td className="px-3 py-1.5 text-[var(--color-text-muted)] whitespace-nowrap">{deal.stage_name ?? '—'}</td>
                  <td className="px-3 py-1.5 text-[var(--color-text-muted)] whitespace-nowrap">{deal.funnel_name ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium whitespace-nowrap">
                    {fmtMoney(deal.amount)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-text-muted)] whitespace-nowrap">
                    {fmt(deal[dateField] as string | null)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {fmt(deal.sold_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DrilldownDrawer({
  target, dimensionType, period, dealScope, productGroupMode, onClose,
}: Props) {
  const params = new URLSearchParams({
    from:             period.from.toISOString(),
    to:               period.to.toISOString(),
    scope:            dealScope,
    productGroupMode,
    ...(dimensionType === 'manager'
      ? { managerId:     target.id }
      : { productGroup:  target.id }),
    ...(target.metricId ? { metricFilter: target.metricId } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['deals-drill', target.id, dimensionType, target.metricId, period.from, period.to, dealScope, productGroupMode],
    queryFn: () => fetch(`/api/reports/deals?${params}`).then(r => r.json()),
  });

  const deals: Deal[] = data?.deals ?? [];

  const groups = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const deal of deals) {
      const key = dimensionType === 'manager'
        ? deal.product_group_display
        : deal.manager_name;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(deal);
    }
    return [...map.entries()].sort((a, b) => {
      const sa = a[1].reduce((s, d) => s + (Number(d.amount) || 0), 0);
      const sb = b[1].reduce((s, d) => s + (Number(d.amount) || 0), 0);
      return sb - sa;
    });
  }, [deals, dimensionType]);

  const metricLabel = target.metricId ? METRIC_LABELS[target.metricId] : undefined;
  const dateField: keyof Deal = (target.metricId ? METRIC_DATE_FIELD[target.metricId] : undefined) ?? 'created_at';

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop — 10% */}
      <div
        className="w-[10%] shrink-0 bg-black/40 cursor-pointer"
        onClick={onClose}
      />

      {/* Drawer — 90% */}
      <div className="flex-1 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-[var(--color-text)] text-base truncate">{target.name}</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5 flex flex-wrap gap-x-2">
              <span>{format(period.from, 'd MMM', { locale: ru })} — {format(period.to, 'd MMM yyyy', { locale: ru })}</span>
              {metricLabel && <span className="text-[var(--color-accent)]">{metricLabel}</span>}
              {!isLoading && <span>{deals.length} сделок</span>}
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-4 p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-12 bg-[var(--color-border)] rounded animate-pulse" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <div className="p-10 text-center text-[var(--color-text-muted)] text-sm">
              Нет сделок за выбранный период
            </div>
          ) : (
            <div>
              {groups.map(([groupName, groupDeals], i) => (
                <GroupSection
                  key={groupName}
                  groupName={groupName}
                  deals={groupDeals}
                  defaultOpen={i === 0}
                  dateField={dateField}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
