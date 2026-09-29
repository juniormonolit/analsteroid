import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, type DateRange } from '@/lib/period';
import { loadManagerInfoMap } from '@/lib/marketing/sources';
import type { ReportRow } from '@/lib/metrics/types';
import { RESPONSE_EXCLUDED_FLOWS } from '@/lib/realizations/responseMetrics';
import { responseDrillRule } from '@/lib/realizations/responseDrill';

// Движок отчёта «Ответы на запросы» (slug 'requests-response', задача #8034).
// Строка = менеджер-постановщик (bitrix created_by); метрики — rr_* из
// lib/realizations/responseMetrics.ts. Одна выборка, GROUPING SETS: строки по
// менеджерам + общая строка (GRAND) для «Итого» — медианы и distinct-сделки
// по всей совокупности, а не сумма строк. Только SELECT по sa.*.

export const RR_GRAND_KEY = '__rr_grand__';

/** results[] задачи: createdAt бывает ISO-строкой или unix-секундами — оба варианта. */
const FIRST_ANSWER_SQL = `(
  select min(case when (e->>'createdAt') ~ '^[0-9]+$' then to_timestamp((e->>'createdAt')::bigint)
                  else (e->>'createdAt')::timestamptz end)
  from jsonb_array_elements(case when jsonb_typeof(t.results) = 'array' then t.results else '[]'::jsonb end) e
  where coalesce(e->>'createdAt', '') <> ''
)`;

/** Базовая выборка задач-запросов периода; $1/$2 — период, $3 — исключённые потоки. */
export function requestTasksCte(extraWhere = ''): string {
  return `
  rq as (
    select t.task_id, t.created_by, t.responsible_id, t.responsible_name, t.status, t.title,
      t.created_at, t.date_start, t.closed_at, t.deal_id, f.name flow_name,
      ${FIRST_ANSWER_SQL} first_answer_at
    from sa.bitrix_task_current t
    join sa.bitrix_flows f on f.flow_id = t.flow_id
    where not coalesce(t.is_deleted, false)
      and t.created_at >= $1 and t.created_at < $2
      and f.name <> all($3::text[])
      ${extraWhere}
  )`;
}

interface AggRow {
  mgr: string | null; grand: number;
  total: string; new_cnt: string; in_work: string; closed: string;
  ttw_med: string | null; cycle_med: string | null; no_take: string;
  answered: string; first_med: string | null; lt3: string; lt9: string;
  deals: string; sold_deals: string; sold_amount: string | null; delivered_deals: string; delivered_amount: string | null;
}

function toMetrics(r: AggRow): Record<string, number | null> {
  const n = (v: string | null) => (v === null ? null : Number(v));
  const h = (v: string | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);
  return {
    rr_requests_total: Number(r.total), rr_requests_new: Number(r.new_cnt), rr_requests_in_work: Number(r.in_work),
    rr_requests_closed: Number(r.closed), rr_time_to_work_med_h: h(r.ttw_med), rr_cycle_med_h: h(r.cycle_med),
    rr_closed_no_take: Number(r.no_take), rr_answered: Number(r.answered), rr_first_answer_med_h: h(r.first_med),
    rr_answer_lt3_cnt: Number(r.lt3), rr_answer_lt9_cnt: Number(r.lt9),
    rr_answer_lt3_pct: Number(r.answered) ? (100 * Number(r.lt3)) / Number(r.answered) : null,
    rr_answer_lt9_pct: Number(r.answered) ? (100 * Number(r.lt9)) / Number(r.answered) : null,
    rr_deals: Number(r.deals), rr_sold_deals: Number(r.sold_deals), rr_sold_amount: n(r.sold_amount) ?? 0,
    rr_delivered_deals: Number(r.delivered_deals), rr_delivered_amount: n(r.delivered_amount) ?? 0,
  };
}

export interface RequestResponseResult { rows: ReportRow[]; grand: Record<string, number | null> | null }

/**
 * managerIds — срез строк (Bitrix id постановщиков); пустой/undefined = все.
 * departmentIds — фильтр отделов отчёта (по оргструктуре sa.org_resolved_hierarchy).
 */
export async function fetchRequestResponse(period: DateRange, opts: { departmentIds?: string[] } = {}): Promise<RequestResponseResult> {
  const { from, toExcl } = toSqlInterval(period);
  const info = await loadManagerInfoMap();
  const params: unknown[] = [from, toExcl, RESPONSE_EXCLUDED_FLOWS];
  let extra = '';
  if (opts.departmentIds && opts.departmentIds.length > 0) {
    const dept = new Set(opts.departmentIds);
    const ids = [...info].filter(([, i]) => i.departmentId && dept.has(i.departmentId)).map(([id]) => Number(id)).filter(Number.isFinite);
    params.push(ids);
    extra = `and t.created_by = any($${params.length}::int[])`;
  }
  const sql = `
with ${requestTasksCte(extra)},
dl as (
  select distinct rq.created_by, d.deal_id, d.sold_at, d.delivered_at, d.amount
  from rq join sa.deals d on d.deal_id = rq.deal_id
)
select a.mgr, a.grand, a.total, a.new_cnt, a.in_work, a.closed, a.ttw_med, a.cycle_med, a.no_take,
  a.answered, a.first_med, a.lt3, a.lt9,
  coalesce(b.deals, 0) deals, coalesce(b.sold_deals, 0) sold_deals, b.sold_amount,
  coalesce(b.delivered_deals, 0) delivered_deals, b.delivered_amount
from (
  select created_by::text mgr, grouping(created_by) grand,
    count(*) total,
    count(*) filter (where status in (1, 2)) new_cnt,
    count(*) filter (where status in (3, 6)) in_work,
    count(*) filter (where status in (4, 5) or closed_at is not null) closed,
    percentile_cont(0.5) within group (order by extract(epoch from date_start - created_at) / 3600) filter (where date_start is not null) ttw_med,
    percentile_cont(0.5) within group (order by extract(epoch from closed_at - created_at) / 3600) filter (where closed_at is not null) cycle_med,
    count(*) filter (where closed_at is not null and date_start is null) no_take,
    count(*) filter (where first_answer_at is not null) answered,
    percentile_cont(0.5) within group (order by extract(epoch from first_answer_at - created_at) / 3600) filter (where first_answer_at is not null) first_med,
    count(*) filter (where first_answer_at - created_at < interval '3 hours') lt3,
    count(*) filter (where first_answer_at - created_at < interval '9 hours') lt9
  from rq group by grouping sets ((created_by), ())
) a
left join (
  select created_by::text mgr, grouping(created_by) grand,
    count(distinct deal_id) deals,
    count(distinct deal_id) filter (where sold_at is not null) sold_deals,
    sum(amount) filter (where sold_at is not null) sold_amount,
    count(distinct deal_id) filter (where delivered_at is not null) delivered_deals,
    sum(amount) filter (where delivered_at is not null) delivered_amount
  from dl
  group by grouping sets ((created_by), ())
) b on b.grand = a.grand and b.mgr is not distinct from a.mgr`;
  // dl — distinct (менеджер, сделка): в строке менеджера сделка один раз. В общей
  // строке sum(amount) задвоил бы сделку двух менеджеров — «Итого» по сделкам ниже
  // пересчитывается отдельным запросом без дубля.
  const res = await analyticsDb().query<AggRow>(sql, params);
  const rows: ReportRow[] = [];
  let grand: Record<string, number | null> | null = null;
  for (const r of res.rows) {
    if (Number(r.grand) === 1) { grand = toMetrics(r); continue; }
    const id = r.mgr ?? '0';
    const mi = info.get(id);
    rows.push({
      dimensionId: id,
      dimensionName: mi?.name ?? (id === '0' ? 'Постановщик не указан' : `Сотрудник #${id}`),
      dimensionSubtitle: mi?.department ?? undefined,
      managerLogin: mi?.login ?? undefined,
      teamId: mi?.departmentId ?? null,
      teamName: mi?.department ?? null,
      branchName: mi?.branch ?? null,
      metrics: toMetrics(r),
    });
  }
  if (grand) {
    // Сделки «Итого» — distinct по всей совокупности (одна сделка у двух менеджеров — один раз).
    const g = await analyticsDb().query<{ deals: string; sold_deals: string; sold_amount: string | null; delivered_deals: string; delivered_amount: string | null }>(`
with ${requestTasksCte(extra)},
d as (select distinct d.deal_id, d.sold_at, d.delivered_at, d.amount from rq join sa.deals d on d.deal_id = rq.deal_id)
select count(*) deals, count(*) filter (where sold_at is not null) sold_deals, sum(amount) filter (where sold_at is not null) sold_amount,
  count(*) filter (where delivered_at is not null) delivered_deals, sum(amount) filter (where delivered_at is not null) delivered_amount from d`, params);
    const x = g.rows[0];
    if (x) Object.assign(grand, {
      rr_deals: Number(x.deals), rr_sold_deals: Number(x.sold_deals), rr_sold_amount: Number(x.sold_amount ?? 0),
      rr_delivered_deals: Number(x.delivered_deals), rr_delivered_amount: Number(x.delivered_amount ?? 0),
    });
  }
  return { rows, grand };
}

export interface RequestTaskItem {
  taskId: number; title: string | null; flow: string | null; status: number | null;
  createdAt: string; dateStart: string | null; closedAt: string | null; firstAnswerAt: string | null;
  responsible: string | null; dealId: number | null; dealSoldAt: string | null; dealDeliveredAt: string | null; dealAmount: number | null;
}

/**
 * Дриллдаун: задачи-запросы менеджера за период (до 2000 строк). managerId = '__all__' — все.
 * metricId — колонка ячейки (задача #8126): список режется тем же условием, что и
 * агрегат (lib/realizations/responseDrill.ts), сделочные метрики — строка на сделку.
 */
export async function fetchRequestTasks(period: DateRange, managerId: string, metricId?: string | null): Promise<RequestTaskItem[]> {
  const { from, toExcl } = toSqlInterval(period);
  const params: unknown[] = [from, toExcl, RESPONSE_EXCLUDED_FLOWS];
  let extra = '';
  if (managerId !== '__all__') {
    const ids = managerId.split(',').filter(s => /^\d+$/.test(s)).map(Number);
    params.push(ids);
    extra = `and t.created_by = any($${params.length}::int[])`;
  }
  const rule = responseDrillRule(metricId);
  const where = rule.where ? `where ${rule.where}` : '';
  const cols = `rq.task_id, rq.title, rq.flow_name, rq.status, rq.created_at, rq.date_start, rq.closed_at, rq.first_answer_at,
  rq.responsible_name, rq.deal_id, d.sold_at, d.delivered_at, d.amount`;
  // perDeal: одна строка на сделку — последний по времени запрос по ней.
  const body = rule.perDeal
    ? `select * from (select distinct on (rq.deal_id) ${cols} from rq left join sa.deals d on d.deal_id = rq.deal_id ${where}
  order by rq.deal_id, rq.created_at desc) x order by x.created_at desc limit 2000`
    : `select ${cols} from rq left join sa.deals d on d.deal_id = rq.deal_id ${where}
order by rq.created_at desc limit 2000`;
  const res = await analyticsDb().query(`
with ${requestTasksCte(extra)}
${body}`, params);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return res.rows.map(r => ({
    taskId: Number(r.task_id), title: r.title ?? null, flow: r.flow_name ?? null, status: r.status === null ? null : Number(r.status),
    createdAt: iso(r.created_at)!, dateStart: iso(r.date_start), closedAt: iso(r.closed_at), firstAnswerAt: iso(r.first_answer_at),
    responsible: r.responsible_name ?? null, dealId: r.deal_id === null ? null : Number(r.deal_id),
    dealSoldAt: iso(r.sold_at), dealDeliveredAt: iso(r.delivered_at), dealAmount: r.amount === null ? null : Number(r.amount),
  }));
}
