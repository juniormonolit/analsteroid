import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, periodDateStrFromInstant, type DateRange } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from './managerActivity';
import { buildCommonDealWhere, type CommonDealFilterOpts } from './commonDealWhere';
import { STAGE_SNAPSHOT_GROUPS } from './stageSnapshot';

// «Кол-во сделок в стадии X» ЗА ПЕРИОД (задача владельца 28.07) — потоковая пара к
// снимкам «Стадии (сейчас)» (#2063): не «сколько стоит в стадии сейчас», а «сколько
// сделок ВПЕРВЫЕ вошло в стадию в периоде» (MIN(event_at) по sa.deal_events — та же
// семантика знаменателей, что в stageConversions.ts/priceObjectionConversion.ts,
// чтобы счётчик стадии и CR-конверсии из неё были сравнимы между собой).
//
// Реестр стадий — ТОТ ЖЕ STAGE_SNAPSHOT_GROUPS (правило Серёги #2063 «имена
// точь-в-точь как стадии», одноимённые стадии воронок 0/1/2/3 склеены): единая
// точка правки при изменении стадий портала. Тройки перв./повт./все — реальным
// JOIN на funnels.is_repeat (как в priceObjectionConversion.ts), не хардкодом
// воронок. Атрибуция менеджера — deal_events.manager_id первого события.
//
// Метрики каталога (migrations/107): stage_entered_{группа}_count (перв.) /
// _repeat (повт.) / _all (все) — metric_type='external', инжект только в
// by-managers (app/api/reports/run + enrichManagerRows), в остальных разрезах null.

export interface StageEnteredCounts {
  primary: number;
  repeat: number;
}

// group key -> counts
export type StageEnteredRow = Record<string, StageEnteredCounts>;

export const STAGE_ENTERED_GROUP_KEYS = Object.keys(STAGE_SNAPSHOT_GROUPS);

export function stageEnteredMetricIds(groupKey: string): { primary: string; repeat: string; all: string } {
  return {
    primary: `stage_entered_${groupKey}_count`,
    repeat: `stage_entered_${groupKey}_count_repeat`,
    all: `stage_entered_${groupKey}_count_all`,
  };
}

export const STAGE_ENTERED_METRIC_IDS: string[] = STAGE_ENTERED_GROUP_KEYS.flatMap(k => {
  const ids = stageEnteredMetricIds(k);
  return [ids.primary, ids.repeat, ids.all];
});

/**
 * Один агрегатный SQL на все группы: VALUES-мапа stage_id → группа, DISTINCT ON
 * (deal_id, группа) с ORDER BY event_at — первый вход сделки в КАЖДУЮ группу
 * считается независимо (сделка может за период побывать и в «Взял в работу», и в
 * «Забронировано»). Возвращает null, если весь период раньше старта сбора
 * deal_events (03.04.2026) — честное «нет данных», как у соседних движков.
 */
// Сделочные фильтры отчёта (физики/юрики, товарные группы, время создания,
// первое касание, «Фильтр сделок») применяются к КОГОРТЕ: сделка, не прошедшая
// фильтр, не попадает ни в знаменатель, ни в числитель (аудит владельца 31.08:
// «все метрики должны подчиняться фильтрации отчёта»).
export async function fetchStageEntered(period: DateRange, filters: CommonDealFilterOpts = {}): Promise<Map<string, StageEnteredRow> | null> {
  const periodToStr = periodDateStrFromInstant(period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const { from, toExcl } = toSqlInterval(period);

  // stage_id — константы кода (STAGE_SNAPSHOT_GROUPS), не пользовательский ввод.
  const valuesRows = STAGE_ENTERED_GROUP_KEYS.flatMap(grp =>
    STAGE_SNAPSHOT_GROUPS[grp].stageIds.map(sid => `('${sid}', '${grp}')`),
  ).join(',\n    ');

  const cw = buildCommonDealWhere(filters, 2);
  const sql = `
WITH stage_groups(stage_id, grp) AS (
  VALUES
    ${valuesRows}
),
first_entry AS (
  SELECT DISTINCT ON (de.deal_id, sg.grp)
    de.deal_id, sg.grp, de.event_at AS first_at, de.manager_id
  FROM deal_events de
  JOIN stage_groups sg ON sg.stage_id = de.stage_id
  ORDER BY de.deal_id, sg.grp, de.event_at ASC
),
cohort AS (
  SELECT * FROM first_entry
  WHERE first_at >= $1 AND first_at < $2
)
SELECT c.manager_id, c.grp, f.is_repeat, COUNT(*)::int AS cnt
FROM cohort c
JOIN deals d ON d.deal_id = c.deal_id
JOIN funnels f ON f.id = d.funnel_id
${cw.sql ? `WHERE ${cw.sql}` : ''}
GROUP BY c.manager_id, c.grp, f.is_repeat
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: number; grp: string; is_repeat: boolean; cnt: number;
  }>(sql, [from, toExcl, ...cw.params]);

  const map = new Map<string, StageEnteredRow>();
  for (const r of res.rows) {
    const managerId = String(r.manager_id);
    let row = map.get(managerId);
    if (!row) {
      row = {};
      map.set(managerId, row);
    }
    const counts = row[r.grp] ?? { primary: 0, repeat: 0 };
    if (r.is_repeat) counts.repeat += r.cnt; else counts.primary += r.cnt;
    row[r.grp] = counts;
  }
  return map;
}
