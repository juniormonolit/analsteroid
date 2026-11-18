// ТОЛЬКО для разработки (`?mock=1`, см. mockBoard.ts): детали задачи и клиент для открытой карточки без API —
// в превью без входа /api/big-deals-kanban/task и /api/modules/client-card отвечают 401.
// Клиента кладём в кэш TanStack Query под ключ ClientModuleWidget (['client-module', qs]) — виджет рисуется как живой.
import type { QueryClient } from '@tanstack/react-query';
import type { ClientModuleData, ModuleDeal } from '@/features/client-module/engine/types';
import type { BigTaskCard } from '../engine/types';
import type { BigTaskDetails } from '../engine/taskDetails';

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

export function mockTaskDetails(card: BigTaskCard): BigTaskDetails {
  const amount = card.deal?.amount ?? card.taskAmount ?? 300_000;
  const product = card.productGroup ?? 'Газобетон';
  return {
    taskId: card.id, status: '3', taskControl: true,
    responsibleId: card.responsible.id, creatorId: card.creator.id,
    description: '',
    fields: [
      { label: 'Клиент', value: card.client ?? 'Иванов Пётр' },
      { label: 'Товары', value: `${product} — ${Math.round(amount / 5000)} шт.\nДоставка манипулятором` },
      { label: 'Общая сумма', value: `${amount.toLocaleString('ru-RU')} ₽` },
      { label: 'Объект', value: 'МО, Истринский р-н, д. Падиково, участок 14' },
    ],
    taskProducts: [product],
    dealProducts: card.deal ? [
      { name: product, qty: Math.round(amount / 5000), price: 4500, sum: Math.round(amount / 5000) * 4500, unit: 'шт' },
      { name: 'Клей для газобетона', qty: 20, price: 450, sum: 9000, unit: 'меш' },
      { name: 'Доставка манипулятором', qty: 1, price: 18000, sum: 18000, unit: 'рейс' },
    ] : null,
    productsChanged: card.id % 2 === 0,
    chat: [
      { id: 1, author: null, authorId: '0', at: iso(3), text: 'Задача создана', system: true },
      { id: 2, author: card.creator.name, authorId: card.creator.id, at: iso(3), text: 'Когда нужен материал? Под какие цели?', system: false },
      { id: 3, author: card.responsible.name, authorId: card.responsible.id, at: iso(2), text: 'Клиенту нужно к 1 декабря, строит дом 10×12. Цену у конкурента нашёл ниже на 5%, просит скидку.', system: false },
    ],
    auditors: card.auditors,
    accomplices: [],
    viewer: { id: '101', canManage: true },
  };
}

/** Клиент по сделке моковой карточки: 0 — нет клиента в сделке (проверка пустого состояния). */
export function mockClientRef(card: BigTaskCard): { contactId: number | null; companyId: number | null } {
  if (!card.deal) return { contactId: null, companyId: null };
  return card.id % 2 ? { contactId: 70_000 + card.id % 100, companyId: null } : { contactId: null, companyId: 50_000 + card.id % 100 };
}

const deal = (id: number, daysAgo: number, stage: ModuleDeal['stage'], amount: number, group: string, stageName: string): ModuleDeal => ({
  dealId: id, name: null, amount, createdAt: iso(daysAgo + 10),
  soldAt: stage === 'sold' || stage === 'shipped' ? iso(daysAgo + 3) : null,
  deliveredAt: stage === 'shipped' ? iso(daysAgo) : null,
  lostAt: stage === 'lost' ? iso(daysAgo) : null,
  stageName, stage, managerName: 'Алексей Смирнов',
  products: [{ name: group, quantity: 10, price: amount / 10, sum: amount, group, isService: false }],
  groups: [group], topGroup: group, objectKey: 'obj1', objectManual: false, looseAddress: null,
});

/** Кладёт мок клиента в кэш, ключ — как у ClientModuleWidget. */
export function seedMockClient(qc: QueryClient, card: BigTaskCard) {
  const { contactId, companyId } = mockClientRef(card);
  if (!contactId && !companyId) return;
  const qs = new URLSearchParams(companyId ? { companyId: String(companyId) } : { contactId: String(contactId) }).toString();
  if (qc.getQueryData(['client-module', qs])) return;
  const company = !!companyId;
  const data: ClientModuleData = {
    ref: (company ? `k${companyId}` : `c${contactId}`) as ClientModuleData["ref"],
    clientType: company ? 'company' : 'contact', clientId: (companyId ?? contactId)!,
    name: card.client ?? (company ? 'ООО «СтройИнвест»' : 'Иванов Пётр'),
    deals: [
      deal(card.deal?.id ?? 1, 0, 'active', card.deal?.amount ?? 500_000, card.productGroup ?? 'Газобетон', card.deal?.stageName ?? 'Подбор товара'),
      deal(2, 60, 'shipped', 240_000, 'Кровля металлочерепица', 'Отгружена'),
      deal(3, 150, 'shipped', 410_000, 'Газобетон', 'Отгружена'),
      deal(4, 200, 'lost', 95_000, 'Утеплитель', 'Дорого'),
    ],
    objects: [{ key: 'obj1', address: 'МО, Истринский р-н, д. Падиково, уч. 14', label: 'Падиково, уч. 14', variants: 1, lat: null, lon: null, requests: [], manual: false, source: '1c' }],
    addressesAvailable: true,
    profile: { clientType: 'self_builder', occupation: '', note: 'Строит дом 10×12, дальше баня', updatedBy: 'Смирнов А.', updatedAt: iso(30) },
    objectProfiles: {}, profilesAvailable: true, v2Available: true, activeDays: 90,
    dismissed: { client: [], byObject: {} }, dismissAvailable: true, profileKind: 'builder',
    recommendations: { client: [{ group: 'Утеплитель', ask: 'Чем будете утеплять?', after: 'Газобетон', pct: 42, pctAfter: null, sources: ['chain'] }], byObject: {} },
    legal: null,
    hint: { type: 'self_builder', occupation: '', confidence: 'medium', reasons: ['Покупал газобетон и кровлю'], warnings: [] },
    lastDealCalls: { total: 4, talked: 2, talkSec: 410, lastAt: iso(1), clientCalls: 0 },
  };
  qc.setQueryData(['client-module', qs], data);
}
