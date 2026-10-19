import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { buildCommonDealWhere, type CommonDealFilterOpts } from './commonDealWhere';
import { resolveClientNames } from '@/lib/bitrix/clientNames';
import type { DateRange } from '@/lib/period';
import type { DealScope } from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';

// ── «Вход и хвост» (задача владельца 19.10) ──────────────────────────────────
//
// Вопрос владельца: «если отключу сделки до 50 тыс. в нерудке — потеряю ~4 млн
// в месяц выручки (~400 тыс. маржи). Но не принесли ли эти же клиенты потом
// деньги на бетоне, арматуре, кровле — и не отрубаю ли я на самом деле больше?»
//
// ВХОД — отгрузки (delivered_at) периода, прошедшие все фильтры отчёта: отделы,
// менеджер, перв./повт., ЧЛ/ЮЛ, товарные группы, «Фильтр сделок» (чек > 50к и
// т.п.), время создания / первой обработки. Те же правила выручки, что у
// clientMetrics: сумма amount отгруженных сделок, воронки 4/7 исключены.
//
// ХВОСТ — все ОСТАЛЬНЫЕ отгрузки тех же клиентов (contact_id) ПОСЛЕ их первой
// входной сделки периода, в окне windowMonths от неё (null — до сегодня).
// Входные сделки в хвост не попадают (они уже в «входе»). Сделки хвоста, которые
// САМИ подходят под условия входа (кроме периода), помечены also_cut — при
// отсечении их бы тоже не было; они входят в хвост, но видны отдельно.
// ДО ВХОДА — отгрузки тех же клиентов раньше первой входной сделки (контекст:
// «это вообще наш старый клиент или он пришёл через эту дверь?»).
//
// «Первая покупка» — входная сделка клиента = самая первая отгрузка клиента за
// всю историю. Хвост ИМЕННО таких клиентов — то, что реально можно потерять,
// закрыв дверь: старые клиенты, скорее всего, продолжат покупать остальное.
//
// Маржа — оценка ~10 % от выручки (решение владельца 19.10), считается на UI.

const EXCLUDED_FUNNELS = '(4, 7)';
const TOP_CLIENTS = 300;

export interface ClientTailOptions extends CommonDealFilterOpts {
  period: DateRange;
  managerIds?: string[];
  departmentIds?: string[];
  dealScope?: DealScope;
  /** Окно хвоста в месяцах от первой входной сделки клиента; null — до сегодня. */
  windowMonths: number | null;
}

export interface TailAgg { deals: number; amount: number; clients: number }
export interface GroupRow extends TailAgg { group: string; alsoCutAmount?: number }
export interface ClientRow {
  contactId: string;
  name: string | null;
  firstEntryAt: string;
  isNew: boolean;
  entryDeals: number;
  entryAmount: number;
  tailDeals: number;
  tailAmount: number;
  beforeAmount: number;
  tailGroups: string[];
}
export interface ClientTailResult {
  entry: TailAgg & { noClientDeals: number; noClientAmount: number; newClients: number };
  tail: TailAgg & { alsoCutDeals: number; alsoCutAmount: number; newClientsAmount: number };
  before: TailAgg;
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
  if (opts.dealScope === 'primary') cond.push('d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)');
  else if (opts.dealScope === 'repeat') cond.push('d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)');
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
         count(*)::int AS entry_deals, COALESCE(sum(amount), 0)::float8 AS entry_amount
    FROM entry WHERE contact_id IS NOT NULL GROUP BY contact_id
),
hist AS (
  SELECT d.deal_id, d.contact_id, d.delivered_at, d.amount,
         COALESCE(d.head_group_name, 'Без группы') AS grp,
         c.first_entry_at,
         (${match}) AS also_cut
    FROM sa.deals d
    JOIN clients c ON c.contact_id = d.contact_id
   WHERE d.delivered_at IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.deal_id = d.deal_id)
),
first_ever AS (
  SELECT c.contact_id,
         NOT EXISTS (SELECT 1 FROM hist h WHERE h.contact_id = c.contact_id AND h.delivered_at < c.first_entry_at) AS is_new
    FROM clients c
),
tail AS (
  SELECT h.*, f.is_new FROM hist h
    JOIN first_ever f ON f.contact_id = h.contact_id
   WHERE h.delivered_at >= h.first_entry_at
     AND (${pWindow} IS NULL OR h.delivered_at < h.first_entry_at + make_interval(months => ${pWindow}))
),
before AS (
  SELECT h.* FROM hist h WHERE h.delivered_at < h.first_entry_at
),
per_client AS (
  SELECT c.contact_id, c.first_entry_at, c.entry_deals, c.entry_amount, f.is_new,
         COALESCE(t.deals, 0) AS tail_deals, COALESCE(t.amount, 0) AS tail_amount,
         COALESCE(b.amount, 0) AS before_amount, t.groups AS tail_groups
    FROM clients c
    JOIN first_ever f USING (contact_id)
    LEFT JOIN (
      SELECT contact_id, sum(n)::int AS deals, sum(amount)::float8 AS amount,
             (array_agg(grp ORDER BY amount DESC NULLS LAST))[1:4] AS groups
        FROM (SELECT contact_id, grp, count(*) AS n, sum(amount) AS amount
                FROM tail GROUP BY contact_id, grp) g
       GROUP BY contact_id
    ) t USING (contact_id)
    LEFT JOIN (SELECT contact_id, sum(amount)::float8 AS amount FROM before GROUP BY contact_id) b USING (contact_id)
)
SELECT json_build_object(
  'entry', (SELECT json_build_object(
      'deals', count(*), 'amount', COALESCE(sum(amount), 0),
      'clients', count(DISTINCT contact_id),
      'noClientDeals', count(*) FILTER (WHERE contact_id IS NULL),
      'noClientAmount', COALESCE(sum(amount) FILTER (WHERE contact_id IS NULL), 0),
      'newClients', (SELECT count(*) FROM first_ever WHERE is_new)) FROM entry),
  'tail', (SELECT json_build_object(
      'deals', count(*), 'amount', COALESCE(sum(amount), 0),
      'clients', count(DISTINCT contact_id),
      'alsoCutDeals', count(*) FILTER (WHERE also_cut),
      'alsoCutAmount', COALESCE(sum(amount) FILTER (WHERE also_cut), 0),
      'newClientsAmount', COALESCE(sum(amount) FILTER (WHERE is_new), 0)) FROM tail),
  'before', (SELECT json_build_object('deals', count(*), 'amount', COALESCE(sum(amount), 0), 'clients', count(DISTINCT contact_id)) FROM before),
  'entryByGroup', (SELECT COALESCE(json_agg(r ORDER BY r.amount DESC), '[]') FROM (
      SELECT grp AS "group", count(*) AS deals, COALESCE(sum(amount), 0)::float8 AS amount, count(DISTINCT contact_id) AS clients
        FROM entry GROUP BY grp) r),
  'tailByGroup', (SELECT COALESCE(json_agg(r ORDER BY r.amount DESC), '[]') FROM (
      SELECT grp AS "group", count(*) AS deals, COALESCE(sum(amount), 0)::float8 AS amount, count(DISTINCT contact_id) AS clients,
             COALESCE(sum(amount) FILTER (WHERE also_cut), 0)::float8 AS "alsoCutAmount"
        FROM tail GROUP BY grp) r),
  'clientsTotal', (SELECT count(*) FROM clients),
  'clients', (SELECT COALESCE(json_agg(r), '[]') FROM (
      SELECT contact_id::text AS "contactId", first_entry_at AS "firstEntryAt", is_new AS "isNew",
             entry_deals AS "entryDeals", entry_amount AS "entryAmount",
             tail_deals AS "tailDeals", tail_amount AS "tailAmount", before_amount AS "beforeAmount",
             COALESCE(tail_groups, '{}') AS "tailGroups"
        FROM per_client ORDER BY tail_amount DESC, entry_amount DESC LIMIT ${pTop}) r)
) AS result`;

  const key = [fromIso, toExclIso, managerIds.join(','), [...deptIds].sort().join(','),
    opts.dealScope ?? 'all', common.key, windowMonths ?? 'all'].join('|');

  const result = await cached(`rpt:client-tail1:${key}`, 15 * 60, async () => {
    const res = await analyticsDb().query<{ result: Omit<ClientTailResult, 'clients'> & { clients: Omit<ClientRow, 'name'>[] } }>(sql, params);
    return res.rows[0].result;
  });

  const names = await resolveClientNames(result.clients.map(c => `c${c.contactId}`)).catch(() => new Map<string, string | null>());
  return {
    ...result,
    clients: result.clients.map(c => ({ ...c, name: names.get(`c${c.contactId}`) ?? null })),
  };
}
