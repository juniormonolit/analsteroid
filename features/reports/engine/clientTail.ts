import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { buildCommonDealWhere, type CommonDealFilterOpts } from './commonDealWhere';
import { resolveClientNames } from '@/lib/bitrix/clientNames';
import type { DateRange } from '@/lib/period';
import { addDays, startOfDay } from 'date-fns';

// ── «Вход и хвост» (задача владельца 19.10) ──────────────────────────────────
//
// Вопрос владельца: «если отключу сделки до 50 тыс. в нерудке — потеряю ~4 млн
// в месяц выручки (~400 тыс. маржи). Но не принесли ли эти же клиенты потом
// деньги на бетоне, арматуре, кровле — и не отрубаю ли я на самом деле больше?»
//
// ВХОД — ПЕРВИЧНЫЕ отгрузки (delivered_at, воронка is_repeat=false — как
// «Отгрузки (перв.)» каталога) периода; правка владельца 19.10: «слева всегда
// только первичные отгрузки в периоде». Плюс все фильтры отчёта: отделы, менеджер, ЧЛ/ЮЛ, товарные группы, «Фильтр сделок» (чек > 50к и
// т.п.), время создания / первой обработки. Те же правила выручки, что у
// clientMetrics: сумма amount отгруженных сделок, воронки 4/7 исключены.
//
// ХВОСТ — все ОСТАЛЬНЫЕ отгрузки тех же клиентов (contact_id) ПОСЛЕ их первой
// входной сделки периода, в окне windowMonths от неё (null — до сегодня).
// Входные сделки в хвост не попадают (они уже в «входе»). Сделки хвоста, которые
// САМИ подходят под условия входа (кроме периода), помечены also_cut — при
// отсечении их бы тоже не было; они входят в хвост, но видны отдельно.
// «До входа» (история клиента раньше входа) убрано по правке владельца 19.10.
//
// СДЕЛКИ и CR в отгрузку (правка владельца 19.10, вместо оценки маржи): «Сделки» —
// созданные (created_at) в том же окне и по тем же условиям; CR = отгрузки ÷
// сделки — события окна делятся друг на друга, как CR каталога и «Дашборда»
// (features/dashboard-test/engine/period.ts), а не путь одних и тех же сделок.
// Во входе окно = период отчёта, в хвосте — от первой входной отгрузки клиента
// (created_at/delivered_at ≥ неё, в пределах windowMonths). Хвост — все воронки.

const EXCLUDED_FUNNELS = '(4, 7)';
const TOP_CLIENTS = 300;

export interface ClientTailOptions extends CommonDealFilterOpts {
  period: DateRange;
  managerIds?: string[];
  departmentIds?: string[];
  /** Окно хвоста в месяцах от первой входной сделки клиента; null — до сегодня. */
  windowMonths: number | null;
}

/** shipments — отгрузки (delivered_at), created — созданные сделки (created_at),
 *  amount — сумма отгрузок, clients — клиентов с отгрузкой. */
export interface TailAgg { shipments: number; created: number; amount: number; clients: number }
export interface GroupRow extends TailAgg { group: string; alsoCutAmount?: number }
export interface ClientRow {
  contactId: string;
  name: string | null;
  firstEntryAt: string;
  entryShipments: number;
  entryAmount: number;
  tailShipments: number;
  tailAmount: number;
  tailGroups: string[];
}
export interface ClientTailResult {
  entry: TailAgg & { noClientDeals: number; noClientAmount: number };
  tail: TailAgg & { alsoCutDeals: number; alsoCutAmount: number };
  entryByGroup: GroupRow[];
  tailByGroup: GroupRow[];
  clients: ClientRow[];
  clientsTotal: number;
}

export async function fetchClientTail(opts: ClientTailOptions): Promise<ClientTailResult> {
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  // Условия ВХОДА без периода — один фрагмент про алиас d: им режем вход и им же
  // помечаем also_cut в хвосте (те же bound-параметры).
  const params: unknown[] = [fromIso, toExclIso];
  const cond: string[] = [];
  const managerIds = (opts.managerIds ?? []).filter(id => /^\d+$/.test(id));
  if (managerIds.length) {
    params.push(managerIds);
    cond.push(`d.current_manager_id::text = ANY($${params.length}::text[])`);
  }
  const deptIds = (opts.departmentIds ?? []).filter(Boolean);
  if (deptIds.length) {
    params.push(deptIds);
    cond.push(`d.current_manager_id::text IN (
      SELECT manager_bitrix_user_id::text FROM sa.org_resolved_hierarchy orh
       WHERE orh.is_active AND orh.department_id IN (
         SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($${params.length}::text[])))`);
  }
  cond.push('d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)');
  const common = buildCommonDealWhere(opts, params.length);
  if (common.sql) { cond.push(common.sql); params.push(...common.params); }
  const match = cond.length ? cond.join(' AND ') : 'true';

  const windowMonths = opts.windowMonths && opts.windowMonths > 0 ? Math.min(Math.round(opts.windowMonths), 120) : null;
  params.push(windowMonths);
  const pWindow = `$${params.length}::int`;
  params.push(TOP_CLIENTS);
  const pTop = `$${params.length}::int`;

  const sql = `
WITH entry AS (
  SELECT d.deal_id, d.contact_id, d.delivered_at, d.amount,
         COALESCE(d.head_group_name, 'Без группы') AS grp
    FROM sa.deals d
   WHERE d.delivered_at >= $1 AND d.delivered_at < $2
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND ${match}
),
clients AS (
  SELECT contact_id, min(delivered_at) AS first_entry_at,
         count(*)::int AS entry_shipments, COALESCE(sum(amount), 0)::float8 AS entry_amount
    FROM entry WHERE contact_id IS NOT NULL GROUP BY contact_id
),
hist AS (
  SELECT d.deal_id, d.contact_id, d.delivered_at, d.amount,
         COALESCE(d.head_group_name, 'Без группы') AS grp,
         c.first_entry_at,
         (${match}) AS also_cut
    FROM sa.deals d
    JOIN clients c ON c.contact_id = d.contact_id
   WHERE d.delivered_at >= c.first_entry_at
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.deal_id = d.deal_id)
),
entry_created AS (
  SELECT COALESCE(d.head_group_name, 'Без группы') AS grp
    FROM sa.deals d
   WHERE d.created_at >= $1 AND d.created_at < $2
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND ${match}
),
tail_created AS (
  SELECT COALESCE(d.head_group_name, 'Без группы') AS grp
    FROM sa.deals d
    JOIN clients c ON c.contact_id = d.contact_id
   WHERE d.created_at >= c.first_entry_at
     AND (${pWindow} IS NULL OR d.created_at < c.first_entry_at + make_interval(months => ${pWindow}))
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.deal_id = d.deal_id)
),
tail AS (
  SELECT h.* FROM hist h
   WHERE h.delivered_at >= h.first_entry_at
     AND (${pWindow} IS NULL OR h.delivered_at < h.first_entry_at + make_interval(months => ${pWindow}))
),
per_client AS (
  SELECT c.contact_id, c.first_entry_at, c.entry_shipments, c.entry_amount,
         COALESCE(t.shipments, 0) AS tail_shipments, COALESCE(t.amount, 0) AS tail_amount,
         t.groups AS tail_groups
    FROM clients c
    LEFT JOIN (
      SELECT contact_id, sum(n)::int AS shipments, sum(amount)::float8 AS amount,
             (array_agg(grp ORDER BY amount DESC NULLS LAST))[1:4] AS groups
        FROM (SELECT contact_id, grp, count(*) AS n, sum(amount) AS amount
                FROM tail GROUP BY contact_id, grp) g
       GROUP BY contact_id
    ) t USING (contact_id)
)
SELECT json_build_object(
  'entry', (SELECT json_build_object(
      'shipments', count(*), 'created', (SELECT count(*) FROM entry_created),
      'amount', COALESCE(sum(amount), 0),
      'clients', count(DISTINCT contact_id),
      'noClientDeals', count(*) FILTER (WHERE contact_id IS NULL),
      'noClientAmount', COALESCE(sum(amount) FILTER (WHERE contact_id IS NULL), 0)) FROM entry),
  'tail', (SELECT json_build_object(
      'shipments', count(*), 'created', (SELECT count(*) FROM tail_created),
      'amount', COALESCE(sum(amount), 0),
      'clients', count(DISTINCT contact_id),
      'alsoCutDeals', count(*) FILTER (WHERE also_cut),
      'alsoCutAmount', COALESCE(sum(amount) FILTER (WHERE also_cut), 0)) FROM tail),
  'entryByGroup', (SELECT COALESCE(json_agg(r ORDER BY r.amount DESC), '[]') FROM (
      SELECT grp AS "group", count(*) AS shipments, COALESCE(sum(amount), 0)::float8 AS amount, count(DISTINCT contact_id) AS clients
        FROM entry GROUP BY grp) r),
  'entryCreatedByGroup', (SELECT COALESCE(json_object_agg(grp, n), '{}') FROM (SELECT grp, count(*) AS n FROM entry_created GROUP BY grp) r),
  'tailCreatedByGroup', (SELECT COALESCE(json_object_agg(grp, n), '{}') FROM (SELECT grp, count(*) AS n FROM tail_created GROUP BY grp) r),
  'tailByGroup', (SELECT COALESCE(json_agg(r ORDER BY r.amount DESC), '[]') FROM (
      SELECT grp AS "group", count(*) AS shipments, COALESCE(sum(amount), 0)::float8 AS amount, count(DISTINCT contact_id) AS clients,
             COALESCE(sum(amount) FILTER (WHERE also_cut), 0)::float8 AS "alsoCutAmount"
        FROM tail GROUP BY grp) r),
  'clientsTotal', (SELECT count(*) FROM clients),
  'clients', (SELECT COALESCE(json_agg(r), '[]') FROM (
      SELECT contact_id::text AS "contactId", first_entry_at AS "firstEntryAt",
             entry_shipments AS "entryShipments", entry_amount AS "entryAmount",
             tail_shipments AS "tailShipments", tail_amount AS "tailAmount",
             COALESCE(tail_groups, '{}') AS "tailGroups"
        FROM per_client ORDER BY tail_amount DESC, entry_amount DESC LIMIT ${pTop}) r)
) AS result`;

  const key = [fromIso, toExclIso, managerIds.join(','), [...deptIds].sort().join(','),
    common.key, windowMonths ?? 'all'].join('|');

  type Raw = Omit<ClientTailResult, 'clients' | 'entryByGroup' | 'tailByGroup'> & {
    clients: Omit<ClientRow, 'name'>[];
    entryByGroup: Omit<GroupRow, 'created'>[];
    tailByGroup: Omit<GroupRow, 'created'>[];
    entryCreatedByGroup: Record<string, number>;
    tailCreatedByGroup: Record<string, number>;
  };
  const raw = await cached(`rpt:client-tail3:${key}`, 15 * 60, async () => {
    const res = await analyticsDb().query<{ result: Raw }>(sql, params);
    return res.rows[0].result;
  });
  const { entryCreatedByGroup, tailCreatedByGroup, ...result } = raw;

  // Группы, где сделки создавались, но отгрузок не было, — тоже строки таблицы
  // (иначе CR по группе молча терял бы знаменатель).
  const mergeGroups = (rows: Omit<GroupRow, 'created'>[], created: Record<string, number>): GroupRow[] => {
    const out: GroupRow[] = rows.map(r => ({ ...r, created: created[r.group] ?? 0 }));
    for (const [group, n] of Object.entries(created)) {
      if (!rows.some(r => r.group === group)) out.push({ group, shipments: 0, created: n, amount: 0, clients: 0 });
    }
    return out;
  };

  const names = await resolveClientNames(result.clients.map(c => `c${c.contactId}`)).catch(() => new Map<string, string | null>());
  return {
    ...result,
    entryByGroup: mergeGroups(result.entryByGroup, entryCreatedByGroup),
    tailByGroup: mergeGroups(result.tailByGroup, tailCreatedByGroup),
    clients: result.clients.map(c => ({ ...c, name: names.get(`c${c.contactId}`) ?? null })),
  };
}
