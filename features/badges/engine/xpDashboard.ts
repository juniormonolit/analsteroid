// Блок «по опыту (XP)» на дашборде «Геймификация» (задача 2745, продолжение
// 2741, бриф Серёги «Дашборд ещё и по опыту сделай и список»): сводка + список
// сотрудников по XP-системе (миграция 124, features/xp/engine/xp.ts).
//
// Источники: xp_ledger (deal_id — одна строка на сделку, total_xp/classes),
// + бонус XP за квесты (fetchQuestXp — quests/quest_contracts status='done').
// «XP за 30 дней» — ТОЛЬКО из xp_ledger (по датам sold_day/ship_day самой
// сделки, не computed_at пересчёта): квестовый бонус даты события не хранит,
// в 30-дневную дельту не входит — ограничение отмечено явно, не подмена данных.

import type { Pool } from 'pg';
import { loadXpSettings, levelFromXp, titleForLevel, fetchQuestXp, xpForLevel } from '@/features/xp/engine/xp';

export interface XpDashboardRow {
  bitrixId: number;
  totalXp: number;
  xp30: number;
  level: number;
  title: string;
  topClass: { name: string; level: number } | null;
}

export interface XpDashboardSummary {
  totalXp: number;
  monthXp: number;
  medianLevel: number;
  topLevel: number;
  titleCounts: Record<string, number>;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Роструем ПО ВСЕМ bitrix_id из xp_ledger (у кого есть хоть одна XP-строка) —
// на дашборде экономики (getBalanceRows) та же логика: ростер добирается из
// оргструктуры на уровне роута, здесь — только те, у кого есть данные.
export async function getXpDashboard(db: Pool): Promise<{ rows: XpDashboardRow[]; summary: XpDashboardSummary }> {
  const [settings, totals, monthXpRes, clsRes, questXp] = await Promise.all([
    loadXpSettings(db),
    db.query<{ bitrix_id: number; total: string; xp30: string }>(
      `SELECT bitrix_id::int AS bitrix_id,
              coalesce(sum(total_xp), 0)::text AS total,
              coalesce(sum(total_xp) FILTER (
                WHERE greatest(coalesce(sold_day, '0001-01-01'::date), coalesce(ship_day, '0001-01-01'::date))
                      >= (current_date - 30)
              ), 0)::text AS xp30
         FROM xp_ledger
        GROUP BY 1`,
    ),
    db.query<{ month_xp: string }>(
      `SELECT coalesce(sum(total_xp), 0)::text AS month_xp
         FROM xp_ledger
        WHERE greatest(coalesce(sold_day, '0001-01-01'::date), coalesce(ship_day, '0001-01-01'::date))
              >= date_trunc('month', now())::date`,
    ),
    db.query<{ bitrix_id: number; name: string; xp: string }>(
      `SELECT l.bitrix_id::int AS bitrix_id, c.key AS name, sum(c.value::numeric)::text AS xp
         FROM xp_ledger l, jsonb_each_text(l.classes) c
        GROUP BY 1, 2`,
    ),
    fetchQuestXp(db),
  ]);

  const bestClass = new Map<number, { name: string; xp: number }>();
  for (const r of clsRes.rows) {
    const xp = Number(r.xp);
    const cur = bestClass.get(r.bitrix_id);
    if (!cur || xp > cur.xp) bestClass.set(r.bitrix_id, { name: r.name, xp });
  }

  const rows: XpDashboardRow[] = totals.rows.map(r => {
    const totalXp = Math.round(Number(r.total)) + (questXp.get(r.bitrix_id) ?? 0);
    const level = levelFromXp(totalXp, settings.levelBase, settings.levelExp);
    const bc = bestClass.get(r.bitrix_id);
    const bcLevel = bc ? levelFromXp(bc.xp, settings.classLevelBase, settings.levelExp) : 0;
    return {
      bitrixId: r.bitrix_id,
      totalXp,
      xp30: Math.round(Number(r.xp30)),
      level,
      title: titleForLevel(level),
      topClass: bc && bcLevel > 0 ? { name: bc.name, level: bcLevel } : null,
    };
  });
  // Менеджеры, чей единственный XP — квестовый бонус (в xp_ledger не попал бы
  // ни строкой): добавляем отдельно, иначе «пропадают» из списка.
  const seen = new Set(rows.map(r => r.bitrixId));
  for (const [bitrixId, xp] of questXp) {
    if (seen.has(bitrixId) || xp <= 0) continue;
    const level = levelFromXp(xp, settings.levelBase, settings.levelExp);
    rows.push({ bitrixId, totalXp: xp, xp30: 0, level, title: titleForLevel(level), topClass: null });
  }

  const totalXp = rows.reduce((s, r) => s + r.totalXp, 0);
  const levels = rows.map(r => r.level);
  const titleCounts: Record<string, number> = {};
  for (const r of rows) titleCounts[r.title] = (titleCounts[r.title] ?? 0) + 1;

  return {
    rows,
    summary: {
      totalXp,
      monthXp: Math.round(Number(monthXpRes.rows[0]?.month_xp ?? 0)),
      medianLevel: median(levels),
      topLevel: levels.length > 0 ? Math.max(...levels) : 0,
      titleCounts,
    },
  };
}

// Реэкспорт для UI (порог следующего уровня — не нужен пока на дашборде, но
// держим xpForLevel доступным без второго импорта в вызывающем коде).
export { xpForLevel };
