// Общие справочники аналитики канбана повторных (sa): оргструктура, менеджеры по Битрикс-id,
// сделки по id и привязка сделки к заказчику. Делят «Аналитика» (analytics.ts), «Результат»
// (results.ts) и события Битрикса в журнале (bitrixEvents.ts).
import { analyticsDb } from '@/lib/db/clients';

export interface OrgNode { id: string; name: string; parentId: string | null }
export interface MgrInfo { name: string; deptId: string | null }

/** Активные подразделения: id — sa.departments.id (тот же, что department_id в оргструктуре). */
export async function fetchOrg(): Promise<OrgNode[]> {
  return analyticsDb().query<{ id: string; name: string; bid: string; pbid: string | null }>(
    `SELECT id::text AS id, name, bitrix_department_id::text AS bid, parent_bitrix_department_id::text AS pbid FROM sa.departments WHERE is_active`,
  ).then(r => {
    const byBid = new Map(r.rows.map(x => [x.bid, x.id]));
    return r.rows.map(x => ({ id: x.id, name: x.name, parentId: x.pbid ? byBid.get(x.pbid) ?? null : null }));
  }).catch(() => [] as OrgNode[]);
}

/** Менеджеры по Битрикс-id (имя, отдел) — и уволенные тоже: их задачи/звонки в периоде остаются. */
export async function fetchManagerDirectory(): Promise<Map<string, MgrInfo>> {
  return analyticsDb().query<{ id: string; name: string | null; dept_id: string | null }>(
    `SELECT DISTINCT ON (manager_bitrix_user_id) manager_bitrix_user_id::text AS id, manager_name AS name, department_id::text AS dept_id
       FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id IS NOT NULL
      ORDER BY manager_bitrix_user_id, is_active DESC`,
  ).then(r => new Map(r.rows.map(x => [x.id, { name: x.name ?? x.id, deptId: x.dept_id }])))
    .catch(() => new Map<string, MgrInfo>());
}

export interface DealRef { dealId: number; funnelId: number; companyId: number | null; contactId: number | null }

/** Сделки по id — поиск по первичному ключу, без прохода по sa.deals. */
export async function fetchDealsById(ids: number[]): Promise<Map<number, DealRef>> {
  if (!ids.length) return new Map();
  const r = await analyticsDb().query<{ deal_id: string; funnel_id: number; company_id: string | null; contact_id: string | null }>(
    `SELECT deal_id, funnel_id, company_id, contact_id FROM sa.deals WHERE deal_id = ANY($1::bigint[])`, [ids],
  );
  return new Map(r.rows.map(x => [Number(x.deal_id), {
    dealId: Number(x.deal_id), funnelId: Number(x.funnel_id),
    companyId: x.company_id !== null ? Number(x.company_id) : null, contactId: x.contact_id !== null ? Number(x.contact_id) : null,
  }]));
}

/**
 * Заказчик сделки — так же, как доска привязывает повторную сделку (board.ts,
 * fetchLatestRepeatDeals): юр-сделка (воронки 1/3) с компанией → компания 'k<id>', иначе —
 * контакт 'p<id>' (у доски ключи c<id> и x<id> — один и тот же контакт). Общая формула
 * CLIENT_KEY_SQL выбросила бы юр-сделки с company_id IS NULL — а задачи на них ставят.
 */
export function refOfDeal(d: Pick<DealRef, 'funnelId' | 'companyId' | 'contactId'>): string | null {
  if ((d.funnelId === 1 || d.funnelId === 3) && d.companyId) return `k${d.companyId}`;
  if (d.contactId) return `p${d.contactId}`;
  return null;
}

/** Ключ заказчика в формате доски/журнала (c/x/k — CLIENT_KEY_SQL) — для имён и поиска.
 *  Юр-сделка без компании (и NULL, и 0) — 'x'<контакт>, как в формуле для company_id = 0. */
export function clientKeyOfDeal(d: Pick<DealRef, 'funnelId' | 'companyId' | 'contactId'>): string | null {
  if (d.funnelId === 0 || d.funnelId === 2) return d.contactId ? `c${d.contactId}` : null;
  if (d.companyId) return `k${d.companyId}`;
  return d.contactId ? `x${d.contactId}` : null;
}

export type Period = 'day' | 'week' | 'month';
export const PERIOD_LEN: Record<Period, number> = { day: 1, week: 7, month: 30 };

/** Границы периода по Москве: [начало первого дня, конец дня date]. */
export function periodBounds(date: string, period: Period): { fromDate: string; from: string; to: string } {
  const days = PERIOD_LEN[period];
  const fromDate = new Date(new Date(`${date}T12:00:00+03:00`).getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { fromDate, from: `${fromDate}T00:00:00+03:00`, to: `${date}T23:59:59.999+03:00` };
}
