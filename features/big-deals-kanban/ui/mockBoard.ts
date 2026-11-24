// ТОЛЬКО для разработки: `?mock=1` в dev рисует экран без API (движок пишется параллельно,
// а войти в превью можно не всегда). В проде флаг игнорируется (см. BigDealsKanbanPage).
// Фильтры, сортировка и свои колонки на моке применяются здесь же, на клиенте (грубо, как движок).
import { BIG_COLUMNS, BIG_DEALS_GROUPS, STUCK_DAYS, taskUrl, dealUrl, type BigColumnKey } from '../engine/config';
import type { BigAnalyticsResponse, BigBoardResponse, BigCustomColumn, BigFilters, BigManagerStat, BigSort, BigTaskCard, BigTaskState, BigTodaySection } from '../engine/types';

// Битрикс отдаёт «Имя Фамилия» — мок так же (проверка shortName → «Фамилия И.»).
const PEOPLE = [
  { id: '101', name: 'Алексей Смирнов' }, { id: '102', name: 'Мария Кузнецова' },
  { id: '103', name: 'Дмитрий Попов' }, { id: '104', name: 'Екатерина Васильева-Константинопольская' },
];
const CLIENTS = ['ООО «СтройИнвест»', 'Иванов Пётр', 'ИП Сидоренко А. В.', 'ООО «Загородные дома Подмосковья и Северо-Запада»'];
const PRODUCTS = ['Газобетон', 'Утеплитель Минеральная вата Технониколь Роклайт', 'Кирпич облицовочный', 'ЖБИ плиты перекрытия', 'Кровля металлочерепица'];
const STATES: BigTaskState[] = ['unread', 'pending', 'in_progress', 'control', 'done', 'deferred'];
// У каких проектов есть колонка (у 72 нет «логиста» и «проверено» — для проверки свёрнутых колонок).
const groupsFor = (k: BigColumnKey) => BIG_DEALS_GROUPS.map(g => g.id).filter(id => !(id === 72 && (k === 'logist' || k === 'lost_done' || k === 'hold')));
const DAY = 86_400_000;

/** Свои колонки мока — в памяти вкладки (POST/PATCH/DELETE на моке пишут сюда). */
let mockCustom: BigCustomColumn[] = [
  { id: 'm1', name: 'Крупные без звонков', filters: { sumMin: 1_000_000, noCalls: true }, createdAt: new Date().toISOString() },
];
export const mockCustomColumns = {
  save(d: { id?: string; name: string; filters: BigFilters }) {
    if (d.id) mockCustom = mockCustom.map(c => (c.id === d.id ? { ...c, name: d.name, filters: d.filters } : c));
    else mockCustom = [...mockCustom, { id: `m${Date.now()}`, name: d.name, filters: d.filters, createdAt: new Date().toISOString() }];
  },
  remove(id: string) { mockCustom = mockCustom.filter(c => c.id !== id); },
};

const amountOf = (c: BigTaskCard) => c.deal?.amount || c.taskAmount || 0;

function allCards(): BigTaskCard[] {
  let n = 0;
  const now = Date.now();
  const card = (column: BigColumnKey, i: number): BigTaskCard => {
    n++;
    const g = BIG_DEALS_GROUPS[(n + i) % BIG_DEALS_GROUPS.length];
    const resp = PEOPLE[n % PEOPLE.length];
    const days = (n * 3) % 9;
    const closed = column === 'sold' ? 'won' : column === 'lost_done' ? 'lost' : null;
    const amount = 150_000 + ((n * 137_000) % 2_400_000);
    const base = {
      id: 480_000 + n, title: `${PRODUCTS[n % PRODUCTS.length]} | ${Math.round(amount / 1000)} тыс | ${resp.name.split(' ')[1]}`,
      groupId: g.id, groupShort: g.short, stageId: 1000 + n, stageTitle: column, column,
      state: STATES[n % STATES.length], responsible: resp, creator: PEOPLE[0], auditors: [], unassigned: resp.id === PEOPLE[0].id,
      createdAt: new Date(now - (days + 2 + (n % 11)) * DAY).toISOString(),
      changedAt: new Date(now - ((n * 2) % 12) * DAY).toISOString(), closedAt: null, deadlineAt: null,
      inColumnSince: new Date(now - days * DAY).toISOString(), daysInColumn: days,
      stuck: days > (STUCK_DAYS[column] ?? 99),
      productGroup: n % 7 === 0 ? null : PRODUCTS[n % PRODUCTS.length],
      productGroups: n % 7 === 0 ? [] : [PRODUCTS[n % PRODUCTS.length]],
      taskAmount: n % 5 === 0 ? amount : null,
      deal: n % 5 === 0 ? null : {
        id: 90_000 + n, title: `Сделка ${n}`, amount, stageId: n % 2 ? 'C1:1' : 'FINAL_INVOICE', stageName: n % 2 ? 'Отправил счет и договор (Бронь)' : 'Созвонился и озвучил цены (ЧЛ)', stageColor: n % 2 ? '#0072BC' : '#FEAD99', categoryId: n % 2 ? 1 : 0, createdAt: new Date(Date.now() - (n % 9 + 2) * 86_400_000).toISOString(), stageAt: new Date(Date.now() - (n % 4 + 1) * 86_400_000 - 3 * 3600_000).toISOString(),
        closed, assigned: resp, contactId: null, companyId: null, url: dealUrl(90_000 + n),
      },
      calls: n % 4 === 3 ? null : { total: n % 3 === 0 ? 0 : n % 6, talks: n % 3, talkSeconds: (n % 5) * 95, lastAt: null },
      related: n % 3 === 1 ? [{ id: 1, title: 'Логист: доставка', groupName: 'Логистика', state: (n % 2 ? 'done' : 'pending') as BigTaskState, responsible: PEOPLE[2], changedAt: null, url: taskUrl(1) }] : [],
      url: taskUrl(480_000 + n),
    };
    // Клиент (поле может появиться в контракте позже) — у части карточек.
    return (n % 3 === 2 ? { ...base, client: CLIENTS[n % CLIENTS.length] } : base) as BigTaskCard;
  };
  return BIG_COLUMNS.flatMap((def, ci) => {
    const count = def.key === 'hold' || def.key === 'logist' ? 0 : 2 + ((ci * 5) % 7);
    return Array.from({ length: count }, (_, i) => card(def.key, i));
  });
}

const dayOf = (iso: string) => iso.slice(0, 10);
export function matchFilters(c: BigTaskCard, f: BigFilters): boolean {
  const idleDays = Math.floor((Date.now() - new Date(c.changedAt ?? c.createdAt).getTime()) / DAY);
  if (f.groups?.length && !f.groups.includes(c.groupId)) return false;
  if (f.manager && c.responsible.id !== f.manager) return false;
  if (f.unassigned && (!c.unassigned || c.state === 'done' || c.column === 'sold' || c.column === 'lost_check' || c.column === 'lost_done')) return false;
  if (f.products?.length && !c.productGroups.some(p => f.products!.includes(p))) return false;
  if (f.q) { const q = f.q.toLowerCase(); if (!(`${c.id} ${c.title} ${c.deal?.title ?? ''} ${(c as { client?: string }).client ?? ''}`.toLowerCase().includes(q))) return false; }
  const a = amountOf(c);
  if (f.sumMin && a < f.sumMin) return false;
  if (f.sumMax && a > f.sumMax) return false;
  if (f.createdFrom && dayOf(c.createdAt) < f.createdFrom) return false;
  if (f.createdTo && dayOf(c.createdAt) > f.createdTo) return false;
  if (f.states?.length && !f.states.includes(c.state)) return false;
  if (f.columns?.length && !f.columns.includes(c.column)) return false;
  if (f.daysMin && c.daysInColumn < f.daysMin) return false;
  if (f.idleDaysMin && idleDays < f.idleDaysMin) return false;
  if (f.stuck && !c.stuck) return false;
  if (f.noCalls && !(c.calls && c.calls.total === 0)) return false;
  if (f.deal === 'open' && c.deal?.closed) return false;
  if ((f.deal === 'won' || f.deal === 'lost') && c.deal?.closed !== f.deal) return false;
  return true;
}

function sortCards(cs: BigTaskCard[], sort: BigSort): BigTaskCard[] {
  const t = (s: string | null) => (s ? new Date(s).getTime() : 0);
  const by: Record<BigSort, ((a: BigTaskCard, b: BigTaskCard) => number) | null> = {
    default: null,
    sum: (a, b) => amountOf(b) - amountOf(a),
    days: (a, b) => b.daysInColumn - a.daysInColumn,
    created: (a, b) => t(b.createdAt) - t(a.createdAt),
    idle: (a, b) => t(a.changedAt ?? a.createdAt) - t(b.changedAt ?? b.createdAt),
  };
  return by[sort] ? [...cs].sort(by[sort]!) : cs;
}

const sumOf = (cs: BigTaskCard[]) => cs.reduce((s, c) => s + amountOf(c), 0);
const section = (key: BigTodaySection['key'], title: string, hint: string, cards: BigTaskCard[], custom?: BigCustomColumn): BigTodaySection =>
  ({ key, title, hint, cards, total: cards.length, sum: sumOf(cards), ...(custom ? { custom } : {}) });

export function mockBoard(filters: BigFilters = {}, sort: BigSort = 'default'): BigBoardResponse {
  const every = allCards();
  const base = every.filter(c => matchFilters(c, filters));
  const columns = BIG_COLUMNS.map(def => {
    const cards = sortCards(base.filter(c => c.column === def.key), sort);
    return { key: def.key, title: def.title, hint: def.hint, color: def.color, total: cards.length, sum: sumOf(cards), cards, groupIds: groupsFor(def.key) };
  });
  const s = (cs: BigTaskCard[]) => sortCards(cs, sort);
  const open = base.filter(c => c.column !== 'sold' && c.column !== 'lost_done');
  // Свои колонки: условия колонки поверх проектов/менеджера/поиска доски.
  const scope: BigFilters = { groups: filters.groups, manager: filters.manager, q: filters.q };
  return {
    columns,
    today: [
      section('control', 'Ждут контроля', 'Менеджер сдал — принять или вернуть', s(open.filter(c => c.state === 'control' && c.column !== 'lost_check'))),
      section('almost_sold', 'Почти продано', 'Подтверждённая бронь, бронь, счёт', s(open.filter(c => c.column === 'reserve_confirmed' || c.column === 'reserve' || c.column === 'invoice'))),
      section('new', 'Новые', 'Разобрать и назначить менеджера', s(open.filter(c => c.column === 'new'))),
      section('stuck', 'Застряли', 'Дольше нормы в колонке', s(open.filter(c => c.stuck && c.column !== 'lost_check'))),
      section('lost_check', 'Проверить отказ', 'Не продано — проверить работу менеджера', s(open.filter(c => c.column === 'lost_check'))),
      section('related_answered', 'Пришёл ответ', 'Связанная задача выполнена', s(open.filter(c => c.related.some(r => r.state === 'done')))),
      ...mockCustom.map(cc => section(`custom:${cc.id}`, cc.name, '', s(every.filter(c => matchFilters(c, { ...cc.filters, ...scope }))), cc)),
    ],
    managers: PEOPLE, productGroups: PRODUCTS,
    groups: BIG_DEALS_GROUPS.map(g => ({ id: g.id, short: g.short, name: g.name })),
    canManage: true, me: '101', generatedAt: new Date().toISOString(), stale: false,
    customColumns: mockCustom,
  };
}

export function mockAnalytics(from: string, to: string): BigAnalyticsResponse {
  const stat = (i: number): BigManagerStat => {
    const tasks = 12 + ((i * 17) % 40), sold = 2 + ((i * 7) % 12), lost = 1 + ((i * 5) % 14), open = Math.max(0, tasks - sold - lost);
    return { manager: PEOPLE[i % PEOPLE.length], tasks, open, sold, lost, conversion: sold / (sold + lost), soldSum: sold * 830_000, openSum: open * 640_000, callsPerTask: i === 3 ? null : 1.5 + (i % 4) };
  };
  const managers = PEOPLE.map((_, i) => stat(i));
  const sum = (k: 'tasks' | 'open' | 'sold' | 'lost' | 'soldSum' | 'openSum') => managers.reduce((s, m) => s + m[k], 0);
  const sold = sum('sold'), lost = sum('lost');
  const conversion = sold / (sold + lost);
  return {
    from, to, by: 'responsible', managers, avgConversion: conversion,
    total: { manager: { id: '', name: 'Итого' }, tasks: sum('tasks'), open: sum('open'), sold, lost, conversion, soldSum: sum('soldSum'), openSum: sum('openSum'), callsPerTask: 2.4 },
  };
}
