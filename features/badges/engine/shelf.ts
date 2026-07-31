// Сборка «полки трофеев» менеджера: награды + определения + прогресс к следующему
// уровню там, где применимо (счётчиковые пороги). Свежие сверху (задача 2655).

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

export async function buildShelf(db: Pool, bitrixId: number): Promise<ShelfItem[]> {
  const [defsRes, awardsRes] = await Promise.all([
    db.query(`SELECT key, name, description, icon, category, tiered, criteria, sort_order
                FROM badge_definitions WHERE enabled ORDER BY sort_order`),
    db.query(
      `SELECT badge_key, tier, period_type, period_date::text AS period_date, value,
              to_char(awarded_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS awarded_at
         FROM badge_awards WHERE bitrix_id = $1
        ORDER BY awarded_at DESC, period_date DESC NULLS LAST`,
      [bitrixId],
    ),
  ]);

  const byKey = new Map<string, typeof awardsRes.rows>();
  for (const a of awardsRes.rows) {
    (byKey.get(a.badge_key) ?? byKey.set(a.badge_key, []).get(a.badge_key)!).push(a);
  }

  const items: ShelfItem[] = [];
  for (const def of defsRes.rows) {
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
