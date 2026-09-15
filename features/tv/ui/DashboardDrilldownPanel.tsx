'use client';
// Раскрытие «Продажи»/«Брони» в список сделок на /today и /rop (задача #6465, Серёга:
// «сделай так, чтобы брони и продажи можно было в сделки раскрывать. Интересно же, кто
// что продал или забронил»). Панель — тот же слайд-ин, что у дрилл-дауна графиков
// (features/charts/ui/ChartDrilldownPanel.tsx): переиспользует DealsListBody/DealsTable
// из features/reports/ui/DrilldownDrawer.tsx (та же таблица, ссылка на сделку в
// Битрикс, копирование ссылки), НЕ новый список с нуля. onDealOpen сознательно не
// передан: /api/reports/deal (карточка сделки) требует сессию, а /today — публичная
// страница без логина — открытие карточки сломало бы её там 401.
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { DealsListBody, type Deal } from '@/features/reports/ui/DrilldownDrawer';

export type DrilldownKind = 'sales' | 'book';

export interface DashboardDrilldownTarget {
  kind: DrilldownKind;
  /** Один из двух: id узла дерева (dept/branch/root) или id менеджера. */
  nodeId?: string;
  managerId?: string;
  /** Заголовок панели — имя узла/менеджера, уже известное клиенту из TvDashboard. */
  label: string;
}

const KIND_LABEL: Record<DrilldownKind, string> = { sales: 'Продажи', book: 'Брони' };
const KIND_DATE_FIELD: Record<DrilldownKind, string> = { sales: 'sold_at', book: 'reserved_at' };
const DRILLDOWN_FIELDS = ['deal_name', 'manager_name', 'product_group_name', 'amount'];

async function fetchDashboardDeals(apiUrl: string, target: DashboardDrilldownTarget): Promise<{ deals: Deal[]; total_count: number; total_amount: number }> {
  const params = new URLSearchParams({ type: target.kind });
  if (target.managerId) params.set('manager', target.managerId);
  else if (target.nodeId) params.set('node', target.nodeId);
  const res = await fetch(`${apiUrl}?${params.toString()}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** apiUrl — /api/tv/dashboard/deals (/today) или /api/rop/dashboard/deals (/rop),
 *  тот же эндпоинт, что уже режет данные по scope у самой страницы. */
export function DashboardDrilldownPanel({ apiUrl, target, onClose }: { apiUrl: string; target: DashboardDrilldownTarget; onClose: () => void }) {
  const { closing, requestClose } = useSlideClose(onClose);
  const dateField = KIND_DATE_FIELD[target.kind];

  return (
    <div className="fixed inset-0 z-[60]">
      <SlideBackdrop closing={closing} onClick={requestClose} className="z-[60]" />
      <div className={`fixed inset-y-0 right-0 z-[61] w-full sm:w-[70vw] sm:min-w-[640px] sm:max-w-[1100px] bg-[var(--color-bg)] shadow-2xl border-l border-[var(--color-border)] flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <PanelCloseTab onClick={requestClose} />
        <div className="flex items-center justify-between gap-2 px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-[var(--color-text)] text-base truncate">{KIND_LABEL[target.kind]} — {target.label}</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5 truncate">Сегодня, {target.kind === 'sales' ? 'по дате продажи' : 'по дате брони'}</p>
          </div>
          <button onClick={requestClose} className="sm:hidden shrink-0 p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors" aria-label="Закрыть">×</button>
        </div>
        <div className="flex-1 overflow-hidden">
          <DealsListBody
            fetchOverride={{
              key: ['dashboard-drilldown', apiUrl, target.kind, target.nodeId ?? '', target.managerId ?? ''],
              fn: () => fetchDashboardDeals(apiUrl, target),
            }}
            dealFields={[...DRILLDOWN_FIELDS, dateField]}
            showChat={false}
            emptyLabel={target.kind === 'sales' ? 'Нет продаж за сегодня' : 'Нет броней за сегодня'}
          />
        </div>
      </div>
    </div>
  );
}
