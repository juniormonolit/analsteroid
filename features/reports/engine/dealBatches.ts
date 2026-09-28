// Режим «Последние N закрытых сделок» (ТЗ владельца 28.09).
//
// Зачем не период: календарь мешает сравнивать людей (разное число рабочих дней,
// отпуска, сезонность) и смещает свежие срезы — быстрые отказы закрываются за день,
// а сделка, которая в итоге продастся, висит неделями, поэтому «конверсия за
// последнюю неделю» всегда выглядит хуже реальной. Пачка из N ЗАКРЫТЫХ сделок этим
// не болеет: база одинаковая у всех.
//
// Решения владельца (28.09), зафиксированы здесь, потому что от них зависит SQL:
//  1. N считается ДЛЯ КАЖДОГО МЕНЕДЖЕРА ОТДЕЛЬНО — у всех берём последние N ЕГО
//     сделок. Иначе сравнение нечестное: 100 сделок по компании — это пять часов
//     работы (487 закрытий в день на проде), а у одного менеджера — два месяца.
//  2. Закрытие — это продажа, отгрузка ИЛИ отказ. Конверсии в продажу и в отгрузку
//     считаются отдельно, поэтому обе даты остаются в игре.
//  3. При нескольких заполненных датах верным считается ПОСЛЕДНИЙ по таймштампу
//     статус: «продана вчера, проиграна сегодня — это отказ». На проде таких
//     сделок 6 757. Ничья (ровно одинаковый таймштамп) трактуется в пользу
//     продажи/отгрузки: «позже» там нет, а считать отказом выигранную сделку хуже.
//  4. Зомби — открытый висяк, который де-факто проигран. Три правила с порогами,
//     срабатывает ЛЮБОЕ включённое. Дата «смерти» считается ОТ СОБЫТИЯ (created_at +
//     N дней и т.п.), а не от now(): иначе все зомби свалились бы в самую свежую
//     пачку и испортили именно её.

import { analyticsDb } from '@/lib/db/clients';
import { getDealBatchSettings, type DealBatchSettings } from '@/lib/reports/dealBatchSettings';

export interface BatchSelection {
  /** deal_id всех сделок всех пачек (для WHERE ... = ANY). */
  dealIds: number[];
  /** Сколько сделок реально набралось (может быть меньше size × менеджеров). */
  managersCovered: number;
  /** Сколько из них — зомби (для подписи в шапке). */
  zombieCount: number;
  size: number;
  useZombies: boolean;
  settings: DealBatchSettings;
}

export interface BatchSelectOptions {
  /** Размер пачки на менеджера. */
  size: number;
  /** Учитывать зомби как проигранные. */
  useZombies: boolean;
  /** Номер пачки: 1 = последние N, 2 = предыдущие N и т.д. (для графиков). */
  batchIndex?: number;
  /** Доп. условия по сделкам (алиас d) — фильтры отчёта, уже с инлайн-литералами. */
  extraWhere?: string;
  /** Ограничить набор менеджеров (bitrix id). Пусто = все. */
  managerIds?: string[] | null;
}

/**
 * SQL-выражение «дата закрытия» и «исход» для алиаса d. Вынесено отдельно, чтобы
 * одинаково использовалось и здесь, и в будущих графиках по пачкам.
 */
export const CLOSED_AT_SQL = `GREATEST(
  COALESCE(d.sold_at,      '-infinity'::timestamptz),
  COALESCE(d.delivered_at, '-infinity'::timestamptz),
  COALESCE(d.lost_at,      '-infinity'::timestamptz))`;

/** Зомби-часть: дата «смерти» по самому раннему сработавшему правилу (LEAST игнорирует NULL). */
function zombieClosedAtSql(s: DealBatchSettings): string | null {
  const parts: string[] = [];
  if (s.age.enabled)   parts.push(`d.created_at + interval '${s.age.days} days'`);
  if (s.idle.enabled)  parts.push(`d.updated_at + interval '${s.idle.days} days'`);
  if (s.stage.enabled) parts.push(`_se.entered + interval '${s.stage.days} days'`);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : `LEAST(${parts.join(', ')})`;
}

/**
 * Последние N закрытых сделок каждого менеджера. batchIndex > 1 отматывает назад:
 * 2 — предыдущие N, 3 — ещё N и так далее (окно для графиков «пачками»).
 */
export async function selectBatchDeals(opts: BatchSelectOptions): Promise<BatchSelection> {
  const settings = await getDealBatchSettings();
  const size = Math.min(5000, Math.max(5, Math.round(opts.size) || settings.defaultBatchSize));
  const idx = Math.max(1, Math.round(opts.batchIndex ?? 1));
  const extra = opts.extraWhere ? ` AND (${opts.extraWhere})` : '';
  const mgrWhere = opts.managerIds && opts.managerIds.length
    ? ` AND d.current_manager_id = ANY($1::bigint[])`
    : '';
  const params: unknown[] = opts.managerIds && opts.managerIds.length ? [opts.managerIds.map(Number)] : [];

  const zombieSql = opts.useZombies ? zombieClosedAtSql(settings) : null;
  const zombiePart = zombieSql
    ? `
    UNION ALL
    SELECT d.deal_id, d.current_manager_id, ${zombieSql} AS closed_at, true AS is_zombie
      FROM deals d
      ${settings.stage.enabled ? `LEFT JOIN LATERAL (
        SELECT MAX(e.event_at) AS entered FROM deal_events e
         WHERE e.deal_id = d.deal_id AND e.stage_id = d.stage_id
      ) _se ON true` : ''}
     WHERE d.current_manager_id IS NOT NULL
       AND d.sold_at IS NULL AND d.delivered_at IS NULL AND d.lost_at IS NULL
       AND (${zombieSql}) IS NOT NULL
       AND (${zombieSql}) <= now()${mgrWhere}${extra}`
    : '';

  const sql = `
WITH u AS (
    SELECT d.deal_id, d.current_manager_id, ${CLOSED_AT_SQL} AS closed_at, false AS is_zombie
      FROM deals d
     WHERE d.current_manager_id IS NOT NULL
       AND (d.sold_at IS NOT NULL OR d.delivered_at IS NOT NULL OR d.lost_at IS NOT NULL)${mgrWhere}${extra}${zombiePart}
), r AS (
    SELECT deal_id, current_manager_id, is_zombie,
           row_number() OVER (PARTITION BY current_manager_id ORDER BY closed_at DESC, deal_id DESC) AS rn
      FROM u
)
SELECT deal_id, current_manager_id::text AS manager_id, is_zombie
  FROM r
 WHERE rn > ${(idx - 1) * size} AND rn <= ${idx * size}`;

  const res = await analyticsDb().query<{ deal_id: string; manager_id: string; is_zombie: boolean }>(sql, params);
  const managers = new Set<string>();
  let zombieCount = 0;
  const dealIds: number[] = [];
  for (const row of res.rows) {
    dealIds.push(Number(row.deal_id));
    managers.add(row.manager_id);
    if (row.is_zombie) zombieCount++;
  }
  return { dealIds, managersCovered: managers.size, zombieCount, size, useZombies: opts.useZombies, settings };
}

/**
 * Опорные даты пачек для оси X графика: медиана даты закрытия внутри каждой пачки.
 * Пачки у разных менеджеров закрываются в разные дни, одной «границы» у пачки нет —
 * медиана честно отвечает на вопрос «когда в среднем закрыта эта сотня».
 * Возвращает YYYY-MM-DD по возрастанию индекса пачки (1 = последняя).
 */
export async function batchBucketDates(opts: {
  size: number; useZombies: boolean; count: number;
  managerIds?: string[] | null; extraWhere?: string;
}): Promise<Map<number, string>> {
  const settings = await getDealBatchSettings();
  const size = Math.min(5000, Math.max(5, Math.round(opts.size) || settings.defaultBatchSize));
  const count = Math.min(24, Math.max(1, Math.round(opts.count) || 1));
  const extra = opts.extraWhere ? ` AND (${opts.extraWhere})` : '';
  const mgrWhere = opts.managerIds && opts.managerIds.length ? ' AND d.current_manager_id = ANY($1::bigint[])' : '';
  const params: unknown[] = opts.managerIds && opts.managerIds.length ? [opts.managerIds.map(Number)] : [];
  const zombieSql = opts.useZombies ? zombieClosedAtSql(settings) : null;
  const zombiePart = zombieSql
    ? `
    UNION ALL
    SELECT d.current_manager_id, ${zombieSql} AS closed_at
      FROM deals d
      ${settings.stage.enabled ? `LEFT JOIN LATERAL (
        SELECT MAX(e.event_at) AS entered FROM deal_events e
         WHERE e.deal_id = d.deal_id AND e.stage_id = d.stage_id
      ) _se ON true` : ''}
     WHERE d.current_manager_id IS NOT NULL
       AND d.sold_at IS NULL AND d.delivered_at IS NULL AND d.lost_at IS NULL
       AND (${zombieSql}) IS NOT NULL AND (${zombieSql}) <= now()${mgrWhere}${extra}`
    : '';

  const sql = `
WITH u AS (
    SELECT d.current_manager_id, ${CLOSED_AT_SQL} AS closed_at
      FROM deals d
     WHERE d.current_manager_id IS NOT NULL
       AND (d.sold_at IS NOT NULL OR d.delivered_at IS NOT NULL OR d.lost_at IS NOT NULL)${mgrWhere}${extra}${zombiePart}
), r AS (
    SELECT closed_at, row_number() OVER (PARTITION BY current_manager_id ORDER BY closed_at DESC) AS rn
      FROM u
)
SELECT ceil(rn::numeric / ${size})::int AS bi,
       -- percentile_DISC, не CONT: continuous-вариант умеет только числа и интервалы,
       -- по timestamptz Postgres падает (42883, живой баг графика пачек 28.09).
       -- Дискретная медиана и логичнее: это реальная дата одной из сделок пачки.
       to_char((percentile_disc(0.5) WITHIN GROUP (ORDER BY closed_at))::date, 'YYYY-MM-DD') AS d
  FROM r
 WHERE rn <= ${size * count}
 GROUP BY 1 ORDER BY 1`;

  const res = await analyticsDb().query<{ bi: number; d: string }>(sql, params);
  const out = new Map<number, string>();
  for (const row of res.rows) if (row.d) out.set(Number(row.bi), row.d);
  return out;
}
