// Пользовательская структура маркетинговых источников (миграция 239): группировки →
// группы → раскладка source_id. Редактируется в «Ещё → Источники», в отчётах — измерение
// `g:<id>` (bySources/byManagers/deals). Кэш на процесс; правка через API сбрасывает его
// сразу (invalidateGroupings), так что отчёт видит раскладку без ожидания TTL.

import { systemDb } from '@/lib/db/clients';

export interface MarketingGroup { id: number; name: string; color: string | null; sort: number }
export interface MarketingGrouping {
  id: number;
  name: string;
  sort: number;
  groups: MarketingGroup[];
  /** source_id → id группы */
  assign: Map<string, number>;
}

let _cache: Map<number, MarketingGrouping> | null = null;
let _cacheAt = 0;
const TTL = 10 * 60 * 1000;

export function invalidateGroupings(): void {
  _cache = null;
}

export async function loadGroupings(): Promise<Map<number, MarketingGrouping>> {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;
  const db = systemDb();
  const [gs, groups, assign] = await Promise.all([
    db.query<{ id: number; name: string; sort: number }>(
      'SELECT id, name, sort FROM marketing_groupings ORDER BY sort, id'),
    db.query<MarketingGroup & { grouping_id: number }>(
      'SELECT id, grouping_id, name, color, sort FROM marketing_groups ORDER BY sort, name'),
    db.query<{ grouping_id: number; source_id: string; group_id: number }>(
      'SELECT grouping_id, source_id, group_id FROM marketing_source_groups'),
  ]);
  const map = new Map<number, MarketingGrouping>();
  for (const g of gs.rows) map.set(g.id, { id: g.id, name: g.name, sort: g.sort, groups: [], assign: new Map() });
  for (const r of groups.rows) map.get(r.grouping_id)?.groups.push({ id: r.id, name: r.name, color: r.color, sort: r.sort });
  for (const r of assign.rows) map.get(r.grouping_id)?.assign.set(r.source_id, r.group_id);
  _cache = map;
  _cacheAt = Date.now();
  return map;
}

/** Список группировок для селекторов отчёта (ключ измерения + название). */
export async function listGroupingDimensions(): Promise<{ key: `g:${number}`; label: string }[]> {
  const map = await loadGroupings();
  return [...map.values()].map(g => ({ key: `g:${g.id}` as const, label: g.name }));
}
