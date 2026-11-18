// Сборка доски «Канбан больших чеков» из снимка задач (load.ts): видимость по зоне, фильтры,
// колонки общей сетки и вкладка «Сегодня».
import type { SessionUser } from '@/lib/auth/session';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { BIG_COLUMNS, BIG_DEALS_GROUPS, COLUMN_PRIORITY, type BigColumnKey } from './config';
import type { BigBoardResponse, BigColumnData, BigPerson, BigTaskCard, BigTodayKey, BigTodaySection } from './types';
import { loadSnapshot, withAge } from './load';
import { stagesOfGroup } from './stages';
import { relatedIndex } from './enrich';

export interface BigBoardFilters {
  groups?: number[];
  manager?: string | null;
  products?: string[] | null;
  q?: string | null;
  force?: boolean;
}

const FINAL_DAYS = 14;
const FINAL = new Set<BigColumnKey>(BIG_COLUMNS.filter(c => c.final).map(c => c.key));

export const cardAmount = (c: BigTaskCard) => c.deal?.amount || c.taskAmount || 0;
const byControlThenAmount = (a: BigTaskCard, b: BigTaskCard) =>
  Number(b.state === 'control') - Number(a.state === 'control') || cardAmount(b) - cardAmount(a) || b.id - a.id;
const prio = (k: BigColumnKey) => { const i = COLUMN_PRIORITY.indexOf(k); return i < 0 ? 99 : i; };
const byPriority = (a: BigTaskCard, b: BigTaskCard) => prio(a.column) - prio(b.column) || cardAmount(b) - cardAmount(a) || b.id - a.id;

/** Карточка в зоне: ответственный, постановщик или ответственный сделки — из зоны; либо пользователь участник. */
export function cardVisible(c: BigTaskCard, zone: Set<string> | null, me: string | null): boolean {
  if (!zone) return true;
  if (me && (c.responsible.id === me || c.creator.id === me || c.auditors.includes(me) || c.deal?.assigned?.id === me)) return true;
  return zone.has(c.responsible.id) || zone.has(c.creator.id) || (!!c.deal?.assigned && zone.has(c.deal.assigned.id));
}

async function columnGroupIds(): Promise<Map<BigColumnKey, number[]>> {
  const out = new Map<BigColumnKey, number[]>();
  await Promise.all(BIG_DEALS_GROUPS.map(async g => {
    const st = await stagesOfGroup(g.id).catch(() => []);
    for (const s of st) if (s.column) {
      const list = out.get(s.column) ?? [];
      if (!list.includes(g.id)) list.push(g.id);
      out.set(s.column, list);
    }
  }));
  for (const k of out.keys()) out.get(k)!.sort((a, b) => a - b);
  return out;
}

/** Чистая сборка из карточек — без сессии (zone = null — всё видно). */
export async function boardFromCards(all: BigTaskCard[], o: {
  zone: Set<string> | null; me: string | null; canManage: boolean; filters: BigBoardFilters; stale: boolean; generatedAt: string;
}): Promise<BigBoardResponse> {
  const now = Date.now();
  // Связанные задачи — из живого индекса (строится в фоне), а не из снимка.
  const rel = relatedIndex();
  const visible = all.filter(c => cardVisible(c, o.zone, o.me)).map(c => {
    const aged = withAge(c, now);
    return rel.size && c.deal ? { ...aged, related: rel.get(`D_${c.deal.id}`) ?? [] } : aged;
  });

  // Что есть в данных — для фильтров (до применения фильтров).
  const people = new Map<string, string>();
  for (const c of visible) {
    people.set(c.responsible.id, c.responsible.name);
    if (c.deal?.assigned) people.set(c.deal.assigned.id, c.deal.assigned.name);
  }
  const managers: BigPerson[] = [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const productGroups = [...new Set(visible.flatMap(c => c.productGroups))].sort((a, b) => a.localeCompare(b, 'ru'));

  const f = o.filters;
  const groups = f.groups?.length ? new Set(f.groups) : null;
  const q = f.q?.trim().toLowerCase() || null;
  const products = f.products?.length ? new Set(f.products) : null;
  const cards = visible.filter(c =>
    (!groups || groups.has(c.groupId))
    && (!f.manager || c.responsible.id === f.manager || c.deal?.assigned?.id === f.manager)
    && (!products || c.productGroups.some(g => products.has(g)))
    && (!q || c.title.toLowerCase().includes(q) || String(c.id) === q || (c.deal && String(c.deal.id) === q) || (c.deal?.title ?? '').toLowerCase().includes(q)));

  const gids = await columnGroupIds();
  const finalCut = now - FINAL_DAYS * 86400_000;
  const columns: BigColumnData[] = BIG_COLUMNS.map(def => {
    const inCol = cards.filter(c => c.column === def.key);
    const shown = def.final
      ? inCol.filter(c => new Date(c.closedAt ?? c.changedAt ?? c.createdAt).getTime() >= finalCut)
      : inCol;
    return {
      key: def.key, title: def.title, hint: def.hint, color: def.color,
      total: inCol.length,
      sum: inCol.reduce((s, c) => s + cardAmount(c), 0),
      cards: [...shown].sort(byControlThenAmount),
      groupIds: gids.get(def.key) ?? [],
    };
  });

  const open = cards.filter(c => c.state !== 'done');
  const relatedAnswered = (c: BigTaskCard) => {
    const mine = new Date(c.changedAt ?? c.createdAt).getTime();
    return c.related.some(r => (r.state === 'done' || r.state === 'control') && r.changedAt && new Date(r.changedAt).getTime() > mine);
  };
  const sec = (key: BigTodayKey, title: string, hint: string, list: BigTaskCard[]): BigTodaySection =>
    ({ key, title, hint, cards: [...list].sort(byPriority) });
  const today: BigTodaySection[] = [
    sec('control', 'Ждут контроля', 'менеджер сдал задачу — принять или вернуть',
      cards.filter(c => c.state === 'control' && !FINAL.has(c.column) && c.column !== 'lost_check')),
    sec('new', 'Новые', 'не разобраны: назначить менеджера и дать ТЗ', open.filter(c => c.column === 'new')),
    sec('stuck', 'Застряли', 'дольше нормы в одной колонке', open.filter(c => c.stuck && c.column !== 'lost_check')),
    // Свежие отказы (за FINAL_DAYS): тысячи старых «Не продано (проверка)» — архив, а не дело на сегодня; они в колонке.
    sec('lost_check', 'Не продано — на проверку', 'проверить работу менеджера и закрыть',
      cards.filter(c => c.column === 'lost_check' && c.state !== 'done' && new Date(c.changedAt ?? c.createdAt).getTime() >= finalCut)),
    sec('related_answered', 'Ответили по связанной задаче', 'логист/снабженец закрыл свою задачу — двигать сделку',
      open.filter(c => !FINAL.has(c.column) && relatedAnswered(c))),
  ];

  return {
    columns, today, managers, productGroups,
    groups: BIG_DEALS_GROUPS.map(g => ({ id: g.id, short: g.short, name: g.name })),
    canManage: o.canManage, me: o.me, generatedAt: o.generatedAt, stale: o.stale,
  };
}

/** Зона пользователя: null — всё (полный доступ), иначе bitrix id менеджеров зоны. */
export async function zoneOf(session: SessionUser): Promise<{ zone: Set<string> | null; canManage: boolean }> {
  const scope = await ropScope(session);
  if (scope.full) return { zone: null, canManage: true };
  const managers = await scopeManagers(scope);
  const zone = new Set(managers.map(m => m.id));
  if (session.bitrixUserId) zone.add(session.bitrixUserId);
  const canManage = !scope.selfOnly && managers.some(m => m.id !== session.bitrixUserId);
  return { zone, canManage };
}

export async function buildBigBoard(session: SessionUser, filters: BigBoardFilters): Promise<BigBoardResponse> {
  const [{ zone, canManage }, snap] = await Promise.all([zoneOf(session), loadSnapshot({ force: filters.force })]);
  return boardFromCards(snap.cards, {
    zone, me: session.bitrixUserId ?? null, canManage, filters, stale: snap.stale, generatedAt: new Date(snap.at).toISOString(),
  });
}

// Для action-роута: обновить одну карточку после изменения задачи.
export { refreshTask, invalidateTask } from './load';
export { markColumn } from './stageSince';
