// Сборка «полки трофеев» менеджера: награды + определения + прогресс к следующему
// уровню там, где применимо (счётчиковые пороги). Свежие сверху (задача 2655).
// buildShelves (доп. Серёги 31.07, награды в /rating): та же сборка БАТЧЕМ для
// списка менеджеров — один запрос awards по ANY(bitrix_ids) вместо N поштучных.

import type { Pool } from 'pg';
import { TIER_ORDER, type BadgeTier } from './catalog';

export interface ShelfTierCount { tier: BadgeTier; count: number; lastPeriod: string | null }

export interface ShelfItem {
  key: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  tiered: boolean;
  // для tiered: счётчик получений каждого уровня; для остальных count/value
  tiers: ShelfTierCount[];
  count: number;               // всего наград (или значение счётчика для counter-бейджей)
  value: number | null;        // счётчик/значение (для counter-бейджей)
  lastAwardedAt: string | null;
  progress: { current: number; target: number } | null; // к порогу, где применимо
}

interface DefRow {
  key: string; name: string; description: string; icon: string; category: string;
  tiered: boolean; criteria: Record<string, unknown> | null; sort_order: number;
}
interface AwardRow {
  badge_key: string; tier: BadgeTier | null; period_type: string | null;
  period_date: string | null; value: string | number | null; awarded_at: string | null;
}

// Общая сборка полки из уже загруженных определений и наград ОДНОГО менеджера —
// единственный источник логики для buildShelf (поштучно) и buildShelves (батч),
// чтобы чипы в /rating гарантированно совпадали с полкой в ЛК.
function assembleShelf(defs: DefRow[], awardRows: AwardRow[]): ShelfItem[] {
  const byKey = new Map<string, AwardRow[]>();
  for (const a of awardRows) {
    (byKey.get(a.badge_key) ?? byKey.set(a.badge_key, []).get(a.badge_key)!).push(a);
  }

  const items: ShelfItem[] = [];
  for (const def of defs) {
    const awards = byKey.get(def.key) ?? [];
    if (awards.length === 0) continue; // полка показывает только полученное
    const criteria = (def.criteria ?? {}) as Record<string, unknown>;

    const tiers: ShelfTierCount[] = TIER_ORDER
      .map((tier) => {
        const of = awards.filter(a => a.tier === tier);
        return { tier, count: of.length, lastPeriod: of[0]?.period_date ?? null };
      })
      .filter(t => t.count > 0);

    const isCounter = awards.length === 1 && awards[0].period_type === null && awards[0].tier === null;
    const value = isCounter && awards[0].value !== null ? Number(awards[0].value) : null;

    // прогресс к следующему порогу для счётчиковых бейджей с порогом в criteria
    let progress: ShelfItem['progress'] = null;
    const threshold = ['minPairs', 'minGroups', 'minRepeats', 'count']
      .map(k => (typeof criteria[k] === 'number' ? (criteria[k] as number) : null))
      .find(v => v !== null);
    if (value !== null && threshold != null && threshold > 1) {
      const nextTarget = value >= threshold ? Math.ceil((value + 1) / threshold) * threshold : threshold;
      progress = { current: value, target: nextTarget };
    }

    items.push({
      key: def.key, name: def.name, description: def.description, icon: def.icon,
      category: def.category, tiered: def.tiered,
      tiers, count: awards.length, value,
      lastAwardedAt: awards[0]?.awarded_at ?? null,
      progress,
    });
  }

  // свежие сверху
  items.sort((a, b) => (b.lastAwardedAt ?? '').localeCompare(a.lastAwardedAt ?? ''));
  return items;
}

const DEFS_SQL = `SELECT key, name, description, icon, category, tiered, criteria, sort_order
                    FROM badge_definitions WHERE enabled ORDER BY sort_order`;
const AWARD_FIELDS = `badge_key, tier, period_type, period_date::text AS period_date, value,
              to_char(awarded_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS awarded_at`;

export async function buildShelf(db: Pool, bitrixId: number): Promise<ShelfItem[]> {
  const [defsRes, awardsRes] = await Promise.all([
    db.query<DefRow>(DEFS_SQL),
    db.query<AwardRow>(
      `SELECT ${AWARD_FIELDS}
         FROM badge_awards WHERE bitrix_id = $1
        ORDER BY awarded_at DESC, period_date DESC NULLS LAST`,
      [bitrixId],
    ),
  ]);
  return assembleShelf(defsRes.rows, awardsRes.rows);
}

// Батч для /rating: полки всех запрошенных менеджеров двумя запросами суммарно.
// В результате только менеджеры, у которых есть хоть одна награда.
export async function buildShelves(db: Pool, bitrixIds: number[]): Promise<Map<number, ShelfItem[]>> {
  const out = new Map<number, ShelfItem[]>();
  if (bitrixIds.length === 0) return out;
  const [defsRes, awardsRes] = await Promise.all([
    db.query<DefRow>(DEFS_SQL),
    db.query<AwardRow & { bitrix_id: number }>(
      `SELECT bitrix_id, ${AWARD_FIELDS}
         FROM badge_awards WHERE bitrix_id = ANY($1::bigint[])
        ORDER BY awarded_at DESC, period_date DESC NULLS LAST`,
      [bitrixIds],
    ),
  ]);
  const byManager = new Map<number, AwardRow[]>();
  for (const a of awardsRes.rows) {
    const id = Number(a.bitrix_id);
    (byManager.get(id) ?? byManager.set(id, []).get(id)!).push(a);
  }
  for (const [id, rows] of byManager) {
    const shelf = assembleShelf(defsRes.rows, rows);
    if (shelf.length > 0) out.set(id, shelf);
  }
  return out;
}
