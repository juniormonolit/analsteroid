// Мок для превью без входа (/bx/big-deals-kanban?mock=1 → задача → «Задачи по сделке» → «Запрос логисту»):
// форма рисуется на этих данных и ничего не отправляет. Только для визуальной проверки вёрстки (375/768).
import type { DealSnapshotResponse, LogistQueue, QueuesResponse, RequestDetails } from '../engine/requests/contract';
import { DEFAULT_SETTINGS } from '../engine/requests/priority';

const q = (id: number, name: string, region: string, dept: string): LogistQueue => ({
  id, groupId: 1000 + id, name, region, dept, productGroups: [], slaHours: null, active: true, source: 'supply_panel', sort: id,
  members: [], membersSyncedAt: null, membersSyncError: null,
});

export const MOCK_QUEUES: QueuesResponse = {
  queues: [q(1, 'мск_Газобетон, кирпич и прочие стеновые', 'МСК', 'ОС'), q(2, 'мск_Кровля и фасад', 'МСК', 'ОС'), q(3, 'спб_Сыпучие материалы', 'СПБ', 'НЦ')],
  settings: DEFAULT_SETTINGS, canManage: false,
};

export const mockSnapshot = (dealId: number): DealSnapshotResponse => ({
  deal: { id: dealId, title: 'Газобетон D500 на объект в Истре', amount: 486_300, categoryId: 0, stageId: 'UC_PU4HM2', url: '#' },
  client: { ref: 'k1', name: 'ООО «СтройДом Истра»' },
  manager: { bitrixId: '1', name: 'Иванов Иван' },
  address: 'Московская обл., г. Истра, ул. Первомайская, 12',
  items: [
    { kind: 'deal_row', bxRowId: 1, bxProductId: 11, name: 'Газобетонный блок D500 600×300×200 Бонолит', quantity: 32, measure: 'м³', ourPrice: 7_450, productGroup: 'Газобетон' },
    { kind: 'deal_row', bxRowId: 2, bxProductId: 12, name: 'Клей для газобетона Бонолит, 25 кг', quantity: 40, measure: 'меш', ourPrice: 420, productGroup: 'Газобетон' },
    { kind: 'deal_row', bxRowId: 3, bxProductId: 13, name: 'Доставка манипулятором', quantity: 2, measure: 'рейс', ourPrice: 9_500, productGroup: null },
  ],
  productGroups: ['Газобетон'], stageType: 'cheaper', defaultQueueId: 1, openByType: { supply: 9001 },
});

export async function mockApi<T>(url: string, init?: RequestInit): Promise<T> {
  await new Promise(r => setTimeout(r, 300));
  if (url.includes('/api/logist-kanban/queues')) return MOCK_QUEUES as T;
  const m = /\/api\/logist-requests\/deal\/(\d+)/.exec(url);
  if (m) return mockSnapshot(Number(m[1])) as T;
  if (init?.method === 'POST' && url.includes('/drafts')) {
    return { request: { id: 9002, queue: MOCK_QUEUES.queues[0], status: 'new' } as unknown as RequestDetails, created: true } as T;
  }
  throw new Error('В моке этого нет');
}
