// Справочники движка диагностики, пересчёт раз в месяц (ТЗ §3.4, §4.3, §6):
//  - diag_lags: квантили времени переходов по товарным группам (для лагов рёбер и прогноза);
//  - diag_zombie_thresholds: порог зомби = P{zombie_quantile} времени «создана → первое
//    движение (бронь/продажа)» по группе, границы [min,max] дней (решение владельца 10.09:
//    зомби — только сделки ДО брони; абсолютной отсечки 5% в данных нет);
//  - diag_season: коэффициент месяца по эталонному периоду (авг-2025…авг-2026), на
//    филиал×направление и '*'.
// Живые данные — только sa через analyticsDb(); результат — в system.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadDiagSettings } from './settings';
import { getManagerOrgMap } from '@/lib/org/deptCategories';

const TRANSITIONS: { key: string; from: string; to: string }[] = [
  { key: 'created_to_reserved', from: 'created_at', to: 'reserved_at' },
  { key: 'reserved_to_sold',    from: 'reserved_at', to: 'sold_at' },
  { key: 'sold_to_shipped',     from: 'sold_at',     to: 'delivered_at' },
  { key: 'created_to_sold',     from: 'created_at',  to: 'sold_at' },
  { key: 'created_to_shipped',  from: 'created_at',  to: 'delivered_at' },
];

export async function computeLags(): Promise<{ rows: number }> {
  const sa = analyticsDb(), sys = systemDb();
  let total = 0;
  for (const t of TRANSITIONS) {
    const r = await sa.query<{ head_group_name: string; n: string; p25: string; p50: string; p75: string; p90: string }>(
      `WITH x AS (
         SELECT coalesce(head_group_name, '∅') AS head_group_name, EXTRACT(epoch FROM (${t.to} - ${t.from})) / 3600 AS h
           FROM sa.deals WHERE ${t.to} IS NOT NULL AND ${t.from} IS NOT NULL AND ${t.to} >= ${t.from}
            AND ${t.to} >= now() - interval '6 months' AND funnel_id IN (0, 1, 2, 3)
       )
       SELECT head_group_name, count(*)::text AS n,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY h)::text AS p25, percentile_cont(0.5) WITHIN GROUP (ORDER BY h)::text AS p50,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY h)::text AS p75, percentile_cont(0.9) WITHIN GROUP (ORDER BY h)::text AS p90
         FROM x GROUP BY ROLLUP (head_group_name)`);
    for (const row of r.rows) {
      const g = row.head_group_name ?? '*';
      await sys.query(
        `INSERT INTO diag_lags (head_group_name, transition, n, p25_h, p50_h, p75_h, p90_h, computed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (head_group_name, transition) DO UPDATE SET n = EXCLUDED.n, p25_h = EXCLUDED.p25_h, p50_h = EXCLUDED.p50_h, p75_h = EXCLUDED.p75_h, p90_h = EXCLUDED.p90_h, computed_at = now()`,
        [g, t.key, Number(row.n), Number(row.p25), Number(row.p50), Number(row.p75), Number(row.p90)]);
      total++;
    }
  }
  return { rows: total };
}

export async function computeZombieThresholds(): Promise<{ groups: number; fallback: number }> {
  const s = await loadDiagSettings();
  const sa = analyticsDb(), sys = systemDb();
  // Время до первого движения среди сделок, которые двинулись (созданы за 6 мес, не моложе 60 дн).
  const r = await sa.query<{ head_group_name: string | null; n: string; q: string; curve: unknown }>(
    `WITH d AS (
       SELECT coalesce(head_group_name, '∅') AS head_group_name,
              EXTRACT(epoch FROM (LEAST(coalesce(reserved_at, 'infinity'::timestamptz), coalesce(sold_at, 'infinity'::timestamptz)) - created_at)) / 86400 AS days
         FROM sa.deals
        WHERE created_at >= now() - interval '6 months' AND created_at < now() - interval '60 days' AND funnel_id IN (0, 1, 2, 3)
          AND (reserved_at IS NOT NULL OR sold_at IS NOT NULL)
     )
     SELECT head_group_name, count(*)::text AS n, percentile_cont($1::float) WITHIN GROUP (ORDER BY days)::text AS q,
            jsonb_build_object('p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY days), 'p75', percentile_cont(0.75) WITHIN GROUP (ORDER BY days),
                               'p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY days), 'p95', percentile_cont(0.95) WITHIN GROUP (ORDER BY days)) AS curve
       FROM d GROUP BY ROLLUP (head_group_name)`, [s.zombieQuantile]);
  let groups = 0, fallbackDays = s.zombieMaxDays;
  const clamp = (q: number) => Math.max(s.zombieMinDays, Math.min(s.zombieMaxDays, Math.ceil(q)));
  const star = r.rows.find(x => x.head_group_name === null);
  if (star) fallbackDays = clamp(Number(star.q));
  for (const row of r.rows) {
    const isStar = row.head_group_name === null;
    const n = Number(row.n);
    const days = isStar ? fallbackDays : (n >= s.zombieMinN ? clamp(Number(row.q)) : fallbackDays);
    await sys.query(
      `INSERT INTO diag_zombie_thresholds (head_group_name, zombie_after_days, n, curve, computed_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (head_group_name) DO UPDATE SET zombie_after_days = EXCLUDED.zombie_after_days, n = EXCLUDED.n, curve = EXCLUDED.curve, computed_at = now()`,
      [isStar ? '*' : row.head_group_name, days, n, JSON.stringify(row.curve ?? [])]);
    groups++;
  }
  return { groups, fallback: fallbackDays };
}

export async function computeSeason(): Promise<{ rows: number }> {
  const s = await loadDiagSettings();
  const sa = analyticsDb(), sys = systemDb();
  // Отгрузки по менеджер×месяц эталонного периода; филиал×направление — из карты
  // оргструктуры (lib/org/deptCategories: category в org_resolved_hierarchy НЕТ, она
  // резолвится по предкам отдела).
  const [r, org] = await Promise.all([
    sa.query<{ m: string; month: number; ym: string; amount: string }>(
      `SELECT d.current_manager_id::text AS m, EXTRACT(month FROM d.delivered_at)::int AS month, to_char(d.delivered_at, 'YYYY-MM') AS ym, sum(d.amount)::text AS amount
         FROM sa.deals d
        WHERE d.delivered_at >= $1::date AND d.delivered_at < ($2::date + interval '1 day') AND d.funnel_id IN (0, 1, 2, 3) AND d.current_manager_id IS NOT NULL
        GROUP BY 1, 2, 3`, [s.seasonRefFrom, s.seasonRefTo]),
    getManagerOrgMap(),
  ]);
  // entity → month → {amount, months(set)}; '*' — компания целиком.
  const acc = new Map<string, Map<number, { amount: number; yms: Set<string> }>>();
  const add = (key: string, month: number, ym: string, amount: number) => {
    const e = acc.get(key) ?? acc.set(key, new Map()).get(key)!;
    const v = e.get(month) ?? e.set(month, { amount: 0, yms: new Set() }).get(month)!;
    v.amount += amount; v.yms.add(ym);
  };
  for (const row of r.rows) {
    const o = org.get(row.m);
    const key = `${o?.branch ?? '∅'}|${o?.category ?? '∅'}`;
    add(key, row.month, row.ym, Number(row.amount));
    add('*', row.month, row.ym, Number(row.amount));
  }
  let rows = 0;
  for (const [key, months] of acc) {
    const perMonthAvg = new Map<number, number>();
    for (const [m, v] of months) perMonthAvg.set(m, v.amount / Math.max(1, v.yms.size));
    const overall = [...perMonthAvg.values()].reduce((a, b) => a + b, 0) / Math.max(1, perMonthAvg.size);
    if (!overall) continue;
    for (const [m, avg] of perMonthAvg) {
      await sys.query(
        `INSERT INTO diag_season (entity_key, month, coef, n_years, computed_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (entity_key, month) DO UPDATE SET coef = EXCLUDED.coef, n_years = EXCLUDED.n_years, computed_at = now()`,
        [key, m, Math.round((avg / overall) * 1000) / 1000, months.get(m)!.yms.size]);
      rows++;
    }
  }
  return { rows };
}

export async function refreshAllRefs(): Promise<{ lags: number; zombieGroups: number; zombieFallback: number; season: number }> {
  const lags = await computeLags();
  const z = await computeZombieThresholds();
  const season = await computeSeason();
  return { lags: lags.rows, zombieGroups: z.groups, zombieFallback: z.fallback, season: season.rows };
}

export async function loadZombieThresholds(): Promise<{ groups: string[]; days: number[]; fallback: number }> {
  const r = await systemDb().query<{ head_group_name: string; zombie_after_days: number }>(`SELECT head_group_name, zombie_after_days FROM diag_zombie_thresholds`);
  const star = r.rows.find(x => x.head_group_name === '*');
  const rest = r.rows.filter(x => x.head_group_name !== '*');
  return { groups: rest.map(x => x.head_group_name), days: rest.map(x => x.zombie_after_days), fallback: star?.zombie_after_days ?? 30 };
}

export interface LagRow { p25: number; p50: number; p75: number; p90: number; n: number }
export async function loadLags(): Promise<Map<string, LagRow>> {
  const r = await systemDb().query<{ head_group_name: string; transition: string; n: number; p25_h: string; p50_h: string; p75_h: string; p90_h: string }>(`SELECT * FROM diag_lags`);
  return new Map(r.rows.map(x => [`${x.head_group_name}|${x.transition}`, { p25: Number(x.p25_h), p50: Number(x.p50_h), p75: Number(x.p75_h), p90: Number(x.p90_h), n: x.n }]));
}
