// Заказчики для чек-листа задачи: из канбана повторных у менеджера — открыто окно
// (≤ 22 дня после отгрузки, сделки нет: колонка pool_hot) и ровно одна отгрузка (shipCounts ['1']).
import { buildRepeatBoard } from '@/features/repeat-kanban/engine/board';
import { WINDOW_DAYS } from '@/features/repeat-kanban/engine/config';
import type { TaskerCustomer } from '../types';
import { portalBaseUrl } from './config';

export function crmUrlOf(clientType: 'contact' | 'company', clientId: number): string {
  return clientType === 'company'
    ? `${portalBaseUrl()}/crm/company/details/${clientId}/`
    : `${portalBaseUrl()}/crm/contact/details/${clientId}/`;
}

/** clientKey канбана (c<id> контакт / k<id> компания / x<id> контакт без компании) → привязка задачи к CRM. */
export function crmBindingOf(clientKey: string): string | null {
  const m = /^([ckx])(\d+)$/.exec(clientKey);
  if (!m) return null;
  return m[1] === 'k' ? `CO_${m[2]}` : `C_${m[2]}`;
}

export async function loadHotCustomers(managerId: string, managerName = ''): Promise<TaskerCustomer[]> {
  const board = await buildRepeatBoard({
    managers: [{ id: managerId, name: managerName }],
    selectedManagers: [],
    typeFilter: null,
    shipCounts: ['1'],
    canManage: false,
    skipNames: false,
    limits: { pool_hot: 500 },
  });
  const col = board.columns.find(c => c.key === 'pool_hot');
  return (col?.cards ?? [])
    .filter(c => String(c.managerId) === String(managerId))
    .map(c => ({
      clientKey: c.clientKey,
      title: c.name ?? `${c.clientType === 'company' ? 'Компания' : 'Контакт'} #${c.clientId}`,
      crmUrl: crmUrlOf(c.clientType, c.clientId),
      shippedAt: c.lastDeliveredAt ? c.lastDeliveredAt.slice(0, 10) : null,
      daysLeft: c.freshDays === null ? null : Math.max(0, WINDOW_DAYS - c.freshDays),
      revenue: c.sumDelivered ?? null,
    }))
    .sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));
}
