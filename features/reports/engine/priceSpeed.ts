import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, periodDateStrFromInstant, type DateRange } from '@/lib/period';
import { loadPriceStageSets } from '@/lib/settings/priceStageMarkup';
import { DEAL_EVENTS_DATA_START } from './managerActivity';
import { buildCommonDealWhere, type CommonDealFilterOpts } from './commonDealWhere';
import { GRAND_TOTAL_KEY, type Bucket } from './callsMetrics';

// «Скорость озвучивания цены» (задача владельца 01.09, миграции 196/197).
//
// Когорта — сделки, СОЗДАННЫЕ в периоде (та же семантика, что у скорости первого
// касания в callsMetrics.ts — метрики сравнимы; атрибуция d.current_manager_id).
// «Цена озвучена» = ПЕРВЫЙ (MIN(event_at)) вход сделки в стадию, размеченную
// 'has_price' в stage_price_markup («Настройки → Цена: разметка стадий»).
// «Спорно» не участвует в расчёте (ТЗ владельца): сделка, чей первый вход в
// 'unclear'-стадию случился ДО первого входа в ценовую (или цены не было вовсе),
// исключается и из числителя, и из знаменателя.
//
// Возвращает на менеджера: медиану часов до цены (тройка перв./повт./все через
// GROUPING SETS — «все» считается по общей совокупности, не средним двух медиан)
// и счётчики reached/denom для CR (тройка собирается calculated-метриками).
// GRAND_TOTAL_KEY — та же медиана по всей отфильтрованной совокупности (для
// строки «Итого», где сумма построчных медиан была бы математически неверна).
export interface PriceSpeedRow {
  medianHours: Bucket;
  reachedPrimary: number;
  reachedRepeat: number;
  denomPrimary: number;
  denomRepeat: number;
}

const emptyRow = (): PriceSpeedRow => ({
  medianHours: { primary: 0, repeat: 0, all: 0 },
  reachedPrimary: 0, reachedRepeat: 0, denomPrimary: 0, denomRepeat: 0,
});

/**
 * null — только если ВЕСЬ период раньше старта сбора deal_events (03.04.2026):
 * честный «данных нет», как у всего семейства стадийных метрик.
 * managerIds — скоуп строк текущего отчёта: ветка GRAND_TOTAL считает медиану
 * по видимой совокупности, а не по всей компании (паттерн callsMetrics 10.07 п.7).
 */
export async function fetchPriceSpeed(
  period: DateRange,
  filters: CommonDealFilterOpts = {},
  managerIds?: string[],
): Promise<Map<string, PriceSpeedRow> | null> {
  const periodToStr = periodDateStrFromInstant(period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const { hasPrice, unclear } = await loadPriceStageSets();
  // Разметка пуста (все ценовые сняты в настройках) — метрика честно пустая,
  // но не null: null зарезервирован под «данных ещё не было».
  const { from, toExcl } = toSqlInterval(period);
  const params: unknown[] = [from, toExcl, hasPrice, unclear];
  const cw = buildCommonDealWhere(filters, params.length);
  params.push(...cw.params);
  let scopeWhere = '';
  if (managerIds && managerIds.length > 0) {
    params.push(managerIds.filter(id => /^\d+$/.test(id)).map(Number));
    scopeWhere = `AND d.current_manager_id = ANY($${params.length}::int[])`;
  }

  const sql = `
WITH cohort AS (
  SELECT d.deal_id, d.current_manager_id AS manager_id, d.created_at, f.is_repeat
  FROM deals d
  JOIN funnels f ON f.id = d.funnel_id
  WHERE d.created_at >= $1 AND d.created_at < $2
    AND d.current_manager_id IS NOT NULL
    ${scopeWhere}
    ${cw.sql ? `AND ${cw.sql}` : ''}
),
price_entry AS (
  SELECT de.deal_id, MIN(de.event_at) AS t_price
  FROM deal_events de
  WHERE de.stage_id = ANY($3::text[])
  GROUP BY de.deal_id
),
unclear_entry AS (
  SELECT de.deal_id, MIN(de.event_at) AS t_unclear
  FROM deal_events de
  WHERE de.stage_id = ANY($4::text[])
  GROUP BY de.deal_id
),
j AS (
  SELECT
    c.manager_id, c.is_repeat,
    -- «Спорно не участвует»: спорная стадия раньше ценовой (или цены нет) — вон из расчёта
    (u.t_unclear IS NOT NULL AND (p.t_price IS NULL OR u.t_unclear < p.t_price)) AS excluded,
    CASE WHEN p.t_price IS NOT NULL AND p.t_price >= c.created_at
         THEN EXTRACT(EPOCH FROM (p.t_price - c.created_at)) / 3600 END AS hours
  FROM cohort c
  LEFT JOIN price_entry p ON p.deal_id = c.deal_id
  LEFT JOIN unclear_entry u ON u.deal_id = c.deal_id
)
SELECT
  manager_id::text AS manager_id,
  is_repeat,
  GROUPING(is_repeat) AS is_all,
  GROUPING(manager_id) AS is_grand,
  count(*) FILTER (WHERE NOT excluded) AS denom,
  count(*) FILTER (WHERE NOT excluded AND hours IS NOT NULL) AS reached,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) FILTER (WHERE NOT excluded) AS median_hours
FROM j
GROUP BY GROUPING SETS ((manager_id, is_repeat), (manager_id), (is_repeat), ())
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: string | null; is_repeat: boolean | null; is_all: number; is_grand: number;
    denom: string; reached: string; median_hours: string | null;
  }>(sql, params);

  const out = new Map<string, PriceSpeedRow>();
  const ensure = (key: string): PriceSpeedRow => {
    let row = out.get(key);
    if (!row) { row = emptyRow(); out.set(key, row); }
    return row;
  };

  for (const r of res.rows) {
    const key = r.is_grand === 1 ? GRAND_TOTAL_KEY : r.manager_id;
    if (key === null) continue;
    const row = ensure(key);
    const median = r.median_hours !== null ? Number(r.median_hours) : 0;
    if (r.is_all === 1) {
      // rollup «(все)» — общая медиана по перв.+повт.
      row.medianHours.all = median;
    } else if (r.is_repeat) {
      row.medianHours.repeat = median;
      row.reachedRepeat = Number(r.reached);
      row.denomRepeat = Number(r.denom);
    } else {
      row.medianHours.primary = median;
      row.reachedPrimary = Number(r.reached);
      row.denomPrimary = Number(r.denom);
    }
  }
  if (!out.has(GRAND_TOTAL_KEY)) out.set(GRAND_TOTAL_KEY, emptyRow());
  return out;
}
