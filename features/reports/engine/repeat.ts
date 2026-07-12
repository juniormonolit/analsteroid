import { analyticsDb, systemDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';

// ── Раздел «Повторные» (задача #1725) ──────────────────────────────────────────
// Отчёты по повторным продажам. Вся логика проверена на живых данных (07–12.07):
//   Repeat Rate физ 18.7% / юр 23.0%; время до 2-го заказа медиана физ 17.8 / юр 12.0 дн;
//   первое касание медиана первичка 45.7 мин / повтор ~4 дн. См. ТЗ:
//   owners-inbox/analsteroid-touch-speed-metrics.md.
//
// Сегментация (единая для всех отчётов раздела):
//   • funnel_id IN (0,2) → ФИЗ (B2C), клиент = contact_id
//   • funnel_id IN (1,3) → ЮР  (B2B), клиент = company_id
//   • воронки 4 (холодные) и 7 (тендеры) ИСКЛЮЧЕНЫ
//   • «покупка» = delivered_at IS NOT NULL
// Триптих касаний перв/повт/все — по funnels.is_repeat (перв = 0,1; повт = 2,3).
//
// Данные читаются штатно из analyticsDb() (та же БД, что sa.deals): sa.deals + мороженые
// per-deal метрики rop.analsteroid_deal_metrics (миграция 088). Времена — МЕДИАНА по
// умолчанию (среднее отдаём рядом справочно).

export type RepeatSegment = 'phys' | 'jur';

export interface RepeatSegmentStats {
  segment: RepeatSegment;
  clients: number;              // клиентов с >=1 отгрузкой
  repeatClients: number;        // клиентов с >=2 отгрузками
  repeatRate: number | null;    // % повторных клиентов
  complexClients: number;       // клиентов с >=2 разными товарными группами за всё время
  complexRate: number | null;   // % комплексных
  avgOrders: number | null;     // среднее кол-во заказов на клиента
  timeToSecondMedian: number | null; // дни: медиана времени до 2-го заказа
  timeToSecondMean: number | null;   // дни: среднее
  timeBetweenMedian: number | null;  // дни: медиана среднего интервала между заказами
  timeBetweenMean: number | null;    // дни: среднее
}

export interface RepeatTouchStats {
  scope: 'primary' | 'repeat' | 'all';
  firstTouchMedian: number | null;      // мин: первое касание
  successfulTouchMedian: number | null; // мин: успешное касание
  cycleTimeMedian: number | null;       // дни: заявка→отгрузка
  dealAgeMedian: number | null;         // дни: возраст до закрытия
  firstCallSuccessRate: number | null;  // % дозвон с 1 раза
  deals: number;
}

export interface RepeatManagerRow {
  managerId: string;
  managerName: string;
  departmentName: string | null;
  clients: number;
  repeatClients: number;
  repeatRate: number | null;
  complexClients: number;
  complexRate: number | null;
}

export interface RepeatReport {
  segments: RepeatSegmentStats[];   // [phys, jur]
  touch: RepeatTouchStats[];        // [primary, repeat, all]
  byManager: RepeatManagerRow[];    // сортировка по clients desc
  updatedAt: string;
}

// Клиент сегмента: физ → contact_id, юр → company_id. Воронки 4/7 исключены везде.
const SEG_CASE = `CASE WHEN d.funnel_id IN (0,2) THEN 'phys' ELSE 'jur' END`;
const CLIENT_CASE = `(CASE WHEN d.funnel_id IN (0,2) THEN d.contact_id ELSE d.company_id END)`;
const DELIVERED_BASE = `
  FROM sa.deals d
  WHERE d.delivered_at IS NOT NULL
    AND d.funnel_id IN (0,1,2,3)
    AND ${CLIENT_CASE} IS NOT NULL`;

function pct(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : null;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

async function fetchSegments(): Promise<RepeatSegmentStats[]> {
  const sql = `
    WITH ord AS (
      SELECT ${SEG_CASE} AS seg,
             ${CLIENT_CASE}::text AS client_id,
             d.delivered_at,
             d.head_group_name,
             row_number() OVER (PARTITION BY ${SEG_CASE}, ${CLIENT_CASE} ORDER BY d.delivered_at) AS rn,
             LAG(d.delivered_at) OVER (PARTITION BY ${SEG_CASE}, ${CLIENT_CASE} ORDER BY d.delivered_at) AS prev_at
      ${DELIVERED_BASE}
    ),
    cl AS (
      SELECT seg, client_id,
             count(*) AS orders,
             count(DISTINCT head_group_name) FILTER (WHERE head_group_name IS NOT NULL) AS groups,
             max(delivered_at) FILTER (WHERE rn = 1) AS d1,
             max(delivered_at) FILTER (WHERE rn = 2) AS d2,
             avg(EXTRACT(EPOCH FROM (delivered_at - prev_at)) / 86400.0) FILTER (WHERE prev_at IS NOT NULL) AS avg_interval
      FROM ord GROUP BY seg, client_id
    )
    SELECT seg,
      count(*) AS clients,
      count(*) FILTER (WHERE orders >= 2) AS repeat_clients,
      count(*) FILTER (WHERE groups >= 2) AS complex_clients,
      avg(orders::numeric) AS avg_orders,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d2 - d1)) / 86400.0)
        FILTER (WHERE d2 IS NOT NULL) AS t2_median,
      avg(EXTRACT(EPOCH FROM (d2 - d1)) / 86400.0) FILTER (WHERE d2 IS NOT NULL) AS t2_mean,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY avg_interval)
        FILTER (WHERE avg_interval IS NOT NULL) AS ti_median,
      avg(avg_interval) FILTER (WHERE avg_interval IS NOT NULL) AS ti_mean
    FROM cl GROUP BY seg`;

  const res = await analyticsDb().query<{
    seg: RepeatSegment; clients: string; repeat_clients: string; complex_clients: string;
    avg_orders: string | null; t2_median: string | null; t2_mean: string | null;
    ti_median: string | null; ti_mean: string | null;
  }>(sql);

  const order: RepeatSegment[] = ['phys', 'jur'];
  return order.map(seg => {
    const r = res.rows.find(x => x.seg === seg);
    const clients = r ? Number(r.clients) : 0;
    const repeatClients = r ? Number(r.repeat_clients) : 0;
    const complexClients = r ? Number(r.complex_clients) : 0;
    return {
      segment: seg,
      clients,
      repeatClients,
      repeatRate: pct(repeatClients, clients),
      complexClients,
      complexRate: pct(complexClients, clients),
      avgOrders: num(r?.avg_orders),
      timeToSecondMedian: num(r?.t2_median),
      timeToSecondMean: num(r?.t2_mean),
      timeBetweenMedian: num(r?.ti_median),
      timeBetweenMean: num(r?.ti_mean),
    };
  });
}

async function fetchTouch(): Promise<RepeatTouchStats[]> {
  const sql = `
    SELECT
      CASE WHEN d.funnel_id IN (0,1) THEN 'primary'
           WHEN d.funnel_id IN (2,3) THEN 'repeat' END AS scope,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY m.first_touch_minutes)
        FILTER (WHERE m.first_touch_minutes IS NOT NULL) AS ft,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY m.successful_touch_minutes)
        FILTER (WHERE m.successful_touch_minutes IS NOT NULL) AS st,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY m.cycle_time_days)
        FILTER (WHERE m.cycle_time_days IS NOT NULL) AS cyc,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY m.deal_age_days)
        FILTER (WHERE m.deal_age_days IS NOT NULL) AS age,
      avg(CASE WHEN m.first_call_success THEN 1.0 ELSE 0.0 END) AS first_call_rate,
      count(*) AS deals
    FROM rop.analsteroid_deal_metrics m
    JOIN sa.deals d ON d.deal_id = m.deal_id
    WHERE d.funnel_id IN (0,1,2,3)
    GROUP BY GROUPING SETS ((1), ())`;

  const res = await analyticsDb().query<{
    scope: 'primary' | 'repeat' | null; ft: string | null; st: string | null;
    cyc: string | null; age: string | null; first_call_rate: string | null; deals: string;
  }>(sql);

  const order: Array<'primary' | 'repeat' | 'all'> = ['primary', 'repeat', 'all'];
  return order.map(scope => {
    const r = res.rows.find(x => (x.scope ?? 'all') === scope);
    return {
      scope,
      firstTouchMedian: num(r?.ft),
      successfulTouchMedian: num(r?.st),
      cycleTimeMedian: num(r?.cyc),
      dealAgeMedian: num(r?.age),
      firstCallSuccessRate: r?.first_call_rate != null ? Math.round(Number(r.first_call_rate) * 1000) / 10 : null,
      deals: r ? Number(r.deals) : 0,
    };
  });
}

// Repeat Rate по менеджерам. Клиент атрибутируется менеджеру ПЕРВОЙ отгрузки (owner).
async function fetchByManager(): Promise<Omit<RepeatManagerRow, 'managerName' | 'departmentName'>[]> {
  const sql = `
    WITH ord AS (
      SELECT ${SEG_CASE} AS seg,
             ${CLIENT_CASE}::text AS client_id,
             d.current_manager_id,
             d.head_group_name,
             row_number() OVER (PARTITION BY ${SEG_CASE}, ${CLIENT_CASE} ORDER BY d.delivered_at) AS rn
      ${DELIVERED_BASE}
        AND d.current_manager_id IS NOT NULL
    ),
    cl AS (
      SELECT seg, client_id,
             (array_agg(current_manager_id ORDER BY rn))[1] AS owner_mgr,
             count(*) AS orders,
             count(DISTINCT head_group_name) FILTER (WHERE head_group_name IS NOT NULL) AS groups
      FROM ord GROUP BY seg, client_id
    )
    SELECT owner_mgr::text AS mgr,
      count(*) AS clients,
      count(*) FILTER (WHERE orders >= 2) AS repeat_clients,
      count(*) FILTER (WHERE groups >= 2) AS complex_clients
    FROM cl WHERE owner_mgr IS NOT NULL
    GROUP BY owner_mgr`;

  const res = await analyticsDb().query<{
    mgr: string; clients: string; repeat_clients: string; complex_clients: string;
  }>(sql);

  return res.rows.map(r => {
    const clients = Number(r.clients);
    const repeatClients = Number(r.repeat_clients);
    const complexClients = Number(r.complex_clients);
    return {
      managerId: r.mgr,
      clients,
      repeatClients,
      repeatRate: pct(repeatClients, clients),
      complexClients,
      complexRate: pct(complexClients, clients),
    };
  });
}

export async function fetchRepeatReport(): Promise<RepeatReport> {
  // Отчёт по всей истории (без period) — тяжёлые запросы кэшируем на 10 мин.
  return cached('repeat:report:v1', 600, async () => {
    const [segments, touch, mgrRaw] = await Promise.all([
      fetchSegments(),
      fetchTouch(),
      fetchByManager(),
    ]);

    // Имена/отделы менеджеров — из системной БД (org_resolved_hierarchy), как в byManagers.ts.
    const orgRes = await systemDb().query<{
      bitrix_user_id: string; manager_name: string; department_name: string | null;
    }>(`SELECT manager_bitrix_user_id::text AS bitrix_user_id, manager_name, department_name
          FROM org_resolved_hierarchy WHERE is_active = true`);
    const orgMap = new Map(orgRes.rows.map(r => [r.bitrix_user_id, r]));

    const byManager: RepeatManagerRow[] = mgrRaw
      .map(m => {
        const org = orgMap.get(m.managerId);
        return {
          ...m,
          managerName: org?.manager_name ?? `#${m.managerId}`,
          departmentName: org?.department_name ?? null,
        };
      })
      // только активная оргструктура (продажники); прочие id (снабжение и т.п.) прячем
      .filter(m => orgMap.has(m.managerId))
      .sort((a, b) => b.clients - a.clients);

    return { segments, touch, byManager, updatedAt: new Date().toISOString() };
  });
}
