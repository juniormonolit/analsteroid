// ТОЛЬКО для разработки: `?mock=1` в dev рисует экран без API (движок пишется параллельно,
// а войти в превью можно не всегда). В проде флаг игнорируется (см. BigDealsKanbanPage).
import { BIG_COLUMNS, BIG_DEALS_GROUPS, STUCK_DAYS, taskUrl, dealUrl, type BigColumnKey } from '../engine/config';
import type { BigBoardResponse, BigTaskCard, BigTaskState } from '../engine/types';

const PEOPLE = [
  { id: '101', name: 'Смирнов Алексей Игоревич' }, { id: '102', name: 'Кузнецова Мария Олеговна' },
  { id: '103', name: 'Попов Дмитрий' }, { id: '104', name: 'Васильева-Константинопольская Екатерина' },
];
const PRODUCTS = ['Газобетон', 'Утеплитель Минеральная вата Технониколь Роклайт', 'Кирпич облицовочный', 'ЖБИ плиты перекрытия', 'Кровля металлочерепица'];
const STATES: BigTaskState[] = ['unread', 'pending', 'in_progress', 'control', 'done', 'deferred'];
// У каких проектов есть колонка (у 72 нет «логиста» и «проверено» — для проверки свёрнутых колонок).
const groupsFor = (k: BigColumnKey) => BIG_DEALS_GROUPS.map(g => g.id).filter(id => !(id === 72 && (k === 'logist' || k === 'lost_done' || k === 'hold')));

export function mockBoard(): BigBoardResponse {
  let n = 0;
  const now = Date.now();
  const card = (column: BigColumnKey, i: number): BigTaskCard => {
    n++;
    const g = BIG_DEALS_GROUPS[(n + i) % BIG_DEALS_GROUPS.length];
    const resp = PEOPLE[n % PEOPLE.length];
    const days = (n * 3) % 9;
    const closed = column === 'sold' ? 'won' : column === 'lost_done' ? 'lost' : null;
    const amount = 150_000 + ((n * 137_000) % 2_400_000);
    return {
      id: 480_000 + n, title: `${PRODUCTS[n % PRODUCTS.length]} | ${Math.round(amount / 1000)} тыс | ${resp.name.split(' ')[0]}`,
      groupId: g.id, groupShort: g.short, stageId: 1000 + n, stageTitle: column, column,
      state: STATES[n % STATES.length], responsible: resp, creator: PEOPLE[0], auditors: [],
      createdAt: new Date(now - (days + 2) * 86_400_000).toISOString(), changedAt: null, closedAt: null, deadlineAt: null,
      inColumnSince: new Date(now - days * 86_400_000).toISOString(), daysInColumn: days,
      stuck: days > (STUCK_DAYS[column] ?? 99),
      productGroup: n % 7 === 0 ? null : PRODUCTS[n % PRODUCTS.length],
      taskAmount: n % 5 === 0 ? amount : null,
      deal: n % 5 === 0 ? null : {
        id: 90_000 + n, title: `Сделка ${n}`, amount, stageId: 'C1:EXECUTING', stageName: n % 2 ? 'Счёт выставлен' : 'Подбор товара',
        closed, assigned: resp, contactId: null, companyId: null, url: dealUrl(90_000 + n),
      },
      calls: n % 4 === 3 ? null : { total: n % 3 === 0 ? 0 : n % 6, talks: n % 3, talkSeconds: (n % 5) * 95, lastAt: null },
      related: n % 3 === 1 ? [{ id: 1, title: 'Логист: доставка', groupName: 'Логистика', state: n % 2 ? 'done' : 'pending', responsible: PEOPLE[2], changedAt: null, url: taskUrl(1) }] : [],
      url: taskUrl(480_000 + n),
    };
  };
  const columns = BIG_COLUMNS.map((def, ci) => {
    const count = def.key === 'hold' || def.key === 'logist' ? 0 : (ci * 5) % 7;
    const cards = Array.from({ length: count }, (_, i) => card(def.key, i));
    return {
      key: def.key, title: def.title, hint: def.hint, color: def.color, total: cards.length,
      sum: cards.reduce((s, c) => s + (c.deal?.amount ?? c.taskAmount ?? 0), 0), cards, groupIds: groupsFor(def.key),
    };
  });
  const all = columns.flatMap(c => c.cards);
  return {
    columns,
    today: [
      { key: 'control', title: 'Ждут контроля', hint: 'Менеджер сдал — принять или вернуть', cards: all.filter(c => c.state === 'control') },
      { key: 'new', title: 'Новые', hint: 'Разобрать и назначить менеджера', cards: columns[0].cards },
      { key: 'stuck', title: 'Застряли', hint: 'Дольше нормы в колонке', cards: all.filter(c => c.stuck) },
      { key: 'lost_check', title: 'Проверить отказ', hint: 'Не продано — проверить работу менеджера', cards: [] },
      { key: 'related_answered', title: 'Пришёл ответ', hint: 'Связанная задача выполнена', cards: all.filter(c => c.related.some(r => r.state === 'done')) },
    ],
    managers: PEOPLE, productGroups: PRODUCTS,
    groups: BIG_DEALS_GROUPS.map(g => ({ id: g.id, short: g.short, name: g.name })),
    canManage: true, me: '101', generatedAt: new Date().toISOString(), stale: true,
  };
}
