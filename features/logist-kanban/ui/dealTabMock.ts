// Мок для превью вкладки сделки без входа и без БД (/bx/deal-requests?deal=123&mock=1 — ТОЛЬКО dev-сборка, см. page.tsx):
// список запросов и карточка №9001 рисуются на этих данных, действия не отправляются. Форма S2 — свой мок (form/mock.ts,
// там же openByType { supply: 9001 }). Только для визуальной проверки вёрстки (375/768).
import type { DealRequestsResponse, RequestCard, RequestDetails } from '../engine/requests/contract';
import { MOCK_QUEUES, mockSnapshot } from '../form/mock';

const H = 3600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
const manager = { bitrixId: '1', name: 'Иванов Иван' };
const logist = { bitrixId: '2', name: 'Петрова Анна' };
const queue = MOCK_QUEUES.queues[0]!;

const card = (dealId: number, over: Partial<RequestCard> & Pick<RequestCard, 'id' | 'type' | 'status'>): RequestCard => ({
  source: 'robot', column: over.status,
  deal: { id: dealId, title: 'Газобетон D500 на объект в Истре', amount: 486_300, categoryId: 0, stageId: 'EXECUTING', url: '#' },
  client: { ref: 'k1', name: 'ООО «СтройДом Истра»' },
  manager, logist: null, queue: { id: queue.id, groupId: queue.groupId, name: queue.name, region: queue.region, dept: queue.dept },
  region: 'МСК', dept: 'ОС', productGroups: ['Газобетон'],
  itemsPreview: 'Газобетонный блок D500 600×300×200 Бонолит 32 м³; Клей для газобетона 40 меш', itemsCount: 3,
  ourTotal: 274_200, competitorTotal: null, amount: 486_300,
  deliveryDate: null, address: 'Московская обл., г. Истра, ул. Первомайская, 12',
  cycle: 1, returnsCount: 0, offersCount: 0,
  createdAt: ago(30), sentAt: ago(30), takenAt: null, answeredAt: null, acceptedAt: null, cancelledAt: null, lastEventAt: ago(2),
  waitingHours: 2, sla: { hours: 8, deadline: ago(-6), leftHours: 6, state: 'ok' },
  priority: { score: 40, reasons: [], factors: [], hot: false },
  dealOutcome: null, bxTaskId: 77001, bxSyncStatus: 'ok', unread: 0, version: 3,
  ...over,
});

export const mockDealRequests = (dealId: number): DealRequestsResponse => {
  const requests = [
    card(dealId, { id: 9001, type: 'supply', status: 'in_work', logist, takenAt: ago(5), unread: 1 }),
    card(dealId, { id: 8990, type: 'cheaper', status: 'accepted', logist, competitorTotal: 251_000, offersCount: 2, cycle: 2, returnsCount: 1,
      createdAt: ago(240), acceptedAt: ago(200), sla: { hours: 8, deadline: null, leftHours: null, state: 'none' }, priority: { score: 0, reasons: [], factors: [], hot: false } }),
  ];
  return { dealId, requests, openByType: { supply: 9001 }, me: { bitrixId: '1', name: 'Иванов Иван', canManage: false, isLogist: false, isRop: false, queueIds: [] }, queues: MOCK_QUEUES.queues };
};

const details = (c: RequestCard): RequestDetails => ({
  ...c,
  purpose: 'Частный дом, 2 этажа', paymentForm: 'Безнал с НДС', comment: 'Нужна доставка до 25.11, разгрузка манипулятором', competitorName: null,
  acceptedOfferId: null, cancelReason: null,
  items: [
    { id: 1, pos: 1, kind: 'deal_row', bxRowId: 1, bxProductId: 11, name: 'Газобетонный блок D500 600×300×200 Бонолит', quantity: 32, measure: 'м³', ourPrice: 7_450, ourSum: 238_400, productGroup: 'Газобетон', competitorPrice: null, comment: null, addedInCycle: 1, files: [] },
    { id: 2, pos: 2, kind: 'deal_row', bxRowId: 2, bxProductId: 12, name: 'Клей для газобетона Бонолит, 25 кг', quantity: 40, measure: 'меш', ourPrice: 420, ourSum: 16_800, productGroup: 'Газобетон', competitorPrice: null, comment: null, addedInCycle: 1, files: [] },
    { id: 3, pos: 3, kind: 'free', bxRowId: null, bxProductId: null, name: 'Армопояс U-блок D500 (нет в 1С)', quantity: 60, measure: 'шт', ourPrice: null, ourSum: null, productGroup: null, competitorPrice: null, comment: 'Уточнить наличие', addedInCycle: 1, files: [] },
  ],
  offers: [],
  messages: [
    { id: 1, author: logist, authorLogin: null, body: 'Взяла. U-блоки уточняю у завода, ответ сегодня до 17:00.', createdAt: ago(4), editedAt: null, deleted: false, files: [] },
  ],
  events: [
    { id: 1, at: ago(30), kind: 'created', cycle: 1, fromStatus: null, toStatus: 'new', queueId: queue.id, actor: null, data: {} },
    { id: 2, at: ago(5), kind: 'taken', cycle: 1, fromStatus: 'new', toStatus: 'in_work', queueId: queue.id, actor: logist, data: {} },
  ],
  watchers: [], files: [], cycles: [],
  dealRowsStatus: 'none', dealRowsError: null, bxSyncError: null,
  can: { update_draft: false, send: false, take: false, release: false, transfer: false, reassign: false, answer: false, withdraw_offer: false, return: false, accept: false, cancel: true, add_items: true, message: true },
  roles: { manager: true, logist: false, queueMember: false, queueLead: false, rop: false, admin: false },
});

/** Подмена fetch на время превью: только адреса вкладки (список по сделке и карточка запроса). */
export function installDealTabMock(dealId: number): void {
  const w = window as Window & { __dealTabMock?: boolean };
  if (w.__dealTabMock) return;
  w.__dealTabMock = true;
  const orig = window.fetch.bind(window);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const data = mockDealRequests(dealId);
    if (/\/api\/logist-kanban\/deal\/\d+/.test(url)) return json(data);
    // форма S2 (новая / «дополнить»): снимок сделки и очереди — из её мока
    if (/\/api\/logist-requests\/deal\/\d+/.test(url)) return json(mockSnapshot(dealId));
    if (url.includes('/api/logist-kanban/queues')) return json(MOCK_QUEUES);
    if (url.includes('/api/logist-kanban/drafts')) return json({ error: 'Превью: в моке ничего не отправляется' }, 400);
    const m = /\/api\/logist-kanban\/request\/(\d+)(\/\w+)?/.exec(url);
    if (m) {
      if (m[2] || (init?.method && init.method !== 'GET')) return json({ error: 'Превью: в моке ничего не отправляется' }, 400);
      const c = data.requests.find(r => r.id === Number(m[1]));
      return c ? json(details(c)) : json({ error: 'Нет в моке' }, 404);
    }
    return orig(input, init);
  };
}
