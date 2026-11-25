// Сборка доски «Канбан больших чеков» из снимка задач (load.ts): видимость по зоне, фильтры,
// колонки общей сетки и вкладка «Сегодня».
import type { SessionUser } from '@/lib/auth/session';
import { BIG_COLUMNS, BIG_DEALS_GROUPS, COLUMN_PRIORITY, type BigColumnKey } from './config';
import type {
  BigBoardResponse, BigColumnData, BigCustomColumn, BigFilters, BigPerson, BigSort, BigTaskCard, BigTodayKey, BigTodaySection,
} from './types';
import { loadSnapshot, withAge } from './load';
import { stagesOfGroup } from './stages';
import { relatedIndex } from './enrich';
import { bigActor } from './actor';
import { canSeeTask, type VisibilityActor } from './visibility';
import { cardAmount, matchFilters, sortComparator } from './filters';
import { listColumns } from './customColumns';

export { cardAmount, matchFilters, sortComparator, filtersFromQuery, normalizeFilters, parseSort, idleDays } from './filters';
export { canSeeTask, canManageTask } from './visibility';

/** Параметры сборки доски: фильтры (BigFilters) + сортировка + force (ждать пересборки снимка). */
export interface BigBoardFilters extends BigFilters { sort?: BigSort; force?: boolean }

const FINAL_DAYS = 14;
const TODAY_LIMIT = 200;
const FINAL = new Set<BigColumnKey>(BIG_COLUMNS.filter(c => c.final).map(c => c.key));
const ALMOST_SOLD: readonly BigColumnKey[] = ['reserve_confirmed', 'reserve', 'invoice'];

const prio = (k: BigColumnKey) => { const i = COLUMN_PRIORITY.indexOf(k); return i < 0 ? 99 : i; };
const byPriority = (a: BigTaskCard, b: BigTaskCard) => prio(a.column) - prio(b.column) || cardAmount(b) - cardAmount(a) || b.id - a.id;
/** «Почти продано»: подтверждённая бронь, потом бронь/счёт, внутри — по сумме. */
const byAlmostSold = (a: BigTaskCard, b: BigTaskCard) =>
  Number(b.column === 'reserve_confirmed') - Number(a.column === 'reserve_confirmed') || cardAmount(b) - cardAmount(a) || b.id - a.id;

/** @deprecated — используйте canSeeTask (visibility.ts). Оставлено для совместимости: zone null = всё видно. */
export function cardVisible(c: BigTaskCard, zone: Set<string> | null, me: string | null): boolean {
  return canSeeTask(c, { userId: me, canManage: false, zone: zone ?? 'all' });
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

/** Видимые пользователю карточки, «состаренные» на now, со связанными задачами из живого индекса. */
export function visibleCards(all: BigTaskCard[], actor: VisibilityActor, now = Date.now()): BigTaskCard[] {
  const rel = relatedIndex();
  return all.filter(c => canSeeTask(c, actor)).map(c => {
    const aged = withAge(c, now);
    return rel.size && c.deal ? { ...aged, related: rel.get(`D_${c.deal.id}`) ?? [] } : aged;
  });
}

/** Чистая сборка из карточек — без сессии (actor.zone = 'all' — всё видно). */
export async function boardFromCards(all: BigTaskCard[], o: {
  actor: VisibilityActor; filters: BigBoardFilters; stale: boolean; generatedAt: string; customColumns?: BigCustomColumn[];
}): Promise<BigBoardResponse> {
  const now = Date.now();
  const visible = visibleCards(all, o.actor, now);

  // Что есть в данных — для фильтров (до применения фильтров).
  const people = new Map<string, string>();
  for (const c of visible) {
    people.set(c.responsible.id, c.responsible.name);
    if (c.deal?.assigned) people.set(c.deal.assigned.id, c.deal.assigned.name);
  }
  const managers: BigPerson[] = [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const productGroups = [...new Set(visible.flatMap(c => c.productGroups))].sort((a, b) => a.localeCompare(b, 'ru'));

  const { sort = 'default', force: _force, ...filters } = o.filters;
  const cards = visible.filter(c => matchFilters(c, filters, now));
  const cmp = sortComparator(sort);

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
      cards: [...shown].sort(cmp),
      groupIds: gids.get(def.key) ?? [],
    };
  });

  const open = cards.filter(c => c.state !== 'done');
  const relatedAnswered = (c: BigTaskCard) => {
    const mine = new Date(c.changedAt ?? c.createdAt).getTime();
    return c.related.some(r => (r.state === 'done' || r.state === 'control') && r.changedAt && new Date(r.changedAt).getTime() > mine);
  };
  // Своя сортировка секции — пока пользователь не выбрал явную (sort !== 'default').
  const sec = (key: BigTodayKey, title: string, hint: string, list: BigTaskCard[], own = byPriority, custom?: BigCustomColumn): BigTodaySection => ({
    key, title, hint, total: list.length, sum: list.reduce((s, c) => s + cardAmount(c), 0),
    cards: [...list].sort(sort === 'default' ? own : cmp).slice(0, TODAY_LIMIT),
    ...(custom ? { custom } : {}),
  });
  const today: BigTodaySection[] = [
    sec('control', 'Ждут контроля', 'менеджер сдал задачу — принять или вернуть',
      cards.filter(c => c.state === 'control' && !FINAL.has(c.column) && c.column !== 'lost_check')),
    sec('almost_sold', 'Почти продано', 'подтверждённая бронь, бронь, счёт — дожать оплату',
      open.filter(c => ALMOST_SOLD.includes(c.column)), byAlmostSold),
    sec('new', 'Новые', 'не разобраны: назначить менеджера и дать ТЗ', open.filter(c => c.column === 'new')),
    sec('stuck', 'Застряли', 'дольше нормы в одной колонке', open.filter(c => c.stuck && c.column !== 'lost_check')),
    // Свежие отказы (за FINAL_DAYS): тысячи старых «Не продано (проверка)» — архив, а не дело на сегодня; они в колонке.
    sec('lost_check', 'Не продано — на проверку', 'проверить работу менеджера и закрыть',
      cards.filter(c => c.column === 'lost_check' && c.state !== 'done' && new Date(c.changedAt ?? c.createdAt).getTime() >= finalCut)),
    sec('related_answered', 'Ответили по связанной задаче', 'логист/снабженец закрыл свою задачу — двигать сделку',
      open.filter(c => !FINAL.has(c.column) && relatedAnswered(c))),
    // Свои колонки пользователя: условия колонки поверх фильтров доски.
    ...(o.customColumns ?? []).map(col =>
      sec(`custom:${col.id}`, col.name, 'своя колонка', cards.filter(c => matchFilters(c, col.filters, now)), byPriority, col)),
  ];

  return {
    columns, today, managers, productGroups,
    groups: BIG_DEALS_GROUPS.map(g => ({ id: g.id, short: g.short, name: g.name })),
    canManage: o.actor.canManage, me: o.actor.userId, generatedAt: o.generatedAt, stale: o.stale,
    customColumns: o.customColumns ?? [],
  };
}

/** Зона пользователя: null — всё (полный доступ), иначе bitrix id менеджеров зоны. @deprecated — bigActor (actor.ts). */
export async function zoneOf(session: SessionUser): Promise<{ zone: Set<string> | null; canManage: boolean }> {
  const a = await bigActor(session);
  return { zone: a.zone === 'all' ? null : a.zone, canManage: a.canManage };
}

export async function buildBigBoard(session: SessionUser, filters: BigBoardFilters): Promise<BigBoardResponse> {
  const [actor, snap, customColumns] = await Promise.all([
    bigActor(session), loadSnapshot({ force: filters.force }), listColumns(session.id),
  ]);
  // «Новое» (25.11): что изменилось для смотрящего с его прошлого открытия; последние сообщения чатов — фоном.
  refreshLastMessages(snap.cards);
  const cards = await withFresh(await withNotes(snap.cards), String(session.id), session.bitrixUserId ?? null);
  return boardFromCards(cards, {
    actor, filters, stale: snap.stale, generatedAt: new Date(snap.at).toISOString(), customColumns,
  });
}

import { withNotes } from './taskNotes';
import { refreshLastMessages, withFresh } from './fresh';

// Для action-роута: обновить одну карточку после изменения задачи.
export { refreshTask, invalidateTask, cardFromSnapshot } from './load';
export { markColumn } from './stageSince';
