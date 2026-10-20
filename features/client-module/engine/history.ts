// Единая «Карточка клиента» (владелец 20.10: «две карточки — в одну»): то, что раньше
// было только в карточке «Моих заказчиков», теперь — вкладками модуля и в приложении,
// и во вкладке Битрикса:
//   * путь покупок (бывший /api/customers/journey): каждая отгрузка с товарными группами
//     по позициям, категория КЦ первой сделки;
//   * лента звонков по ВСЕМ сделкам клиента (va.calls), успешный — дольше 20 с;
//   * кто вёл заказчика — менеджеры по сделкам, имена на момент работы.
// Клиент — ClientRef модуля: c<contact> = все сделки контакта (B2C и юр без компании
// вместе, решение владельца 20.10), k<company> — компания.
import { analyticsDb } from '@/lib/db/clients';
import type { ClientRef } from './types';

export interface HistoryPurchase {
  dealId: number; dealName: string | null; amount: number; deliveredAt: string;
  headGroup: string | null; kcCategory: string | null; groups: { name: string | null; sum: number }[];
}
export interface HistoryCall { calledAt: string; durationSec: number; direction: 'inbound' | 'outbound' | null; missed: boolean; dealId: number | null; managerName: string | null }
export interface HistoryManager { managerId: string; name: string | null; deals: number; sold: number; firstAt: string; lastAt: string }

export interface ClientHistory {
  purchases: HistoryPurchase[];
  calls: HistoryCall[];
  callsTotal: number;
  goodCallsTotal: number;
  managers: HistoryManager[];
}

const CALLS_LIMIT = 100;

export async function fetchClientHistory(ref: ClientRef): Promise<ClientHistory> {
  const where = ref.startsWith('k') ? 'd.company_id = $1' : 'd.contact_id = $1';
  const id = Number(ref.slice(1));
  const db = analyticsDb();
  const [purchases, calls, totals, managers] = await Promise.all([
    db.query<{ deal_id: number; deal_name: string | null; amount: string | null; delivered_at: Date; head_group_name: string | null; kc_name: string | null; groups: HistoryPurchase['groups'] | null }>(
      `SELECT d.deal_id, d.deal_name, d.amount, d.delivered_at, d.head_group_name, pg.name AS kc_name,
              (SELECT jsonb_agg(g) FROM (
                 SELECT COALESCE(p->>'head_group_name', 'Без группы') AS name, SUM((p->>'sum')::numeric)::float8 AS sum
                   FROM jsonb_array_elements(d.products) p GROUP BY 1 ORDER BY 2 DESC) g) AS groups
         FROM sa.deals d LEFT JOIN product_groups pg ON pg.id = d.product_group_id
        WHERE ${where} AND d.delivered_at IS NOT NULL AND d.funnel_id NOT IN (4, 7)
        ORDER BY d.delivered_at ASC, d.deal_id ASC`,
      [id],
    ),
    db.query<{ called_at: Date; duration_seconds: number | null; direction: string | null; result: string | null; deal_id: number | null; manager_name: string | null }>(
      `SELECT c.called_at, c.duration_seconds, c.direction, c.result, c.deal_id, org.manager_name
         FROM va.calls c
         LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = c.manager_id::text
        WHERE c.deal_id IN (SELECT d.deal_id FROM sa.deals d WHERE ${where})
        ORDER BY c.called_at DESC LIMIT ${CALLS_LIMIT}`,
      [id],
    ),
    db.query<{ total: string; good: string }>(
      `SELECT count(*)::text AS total, count(*) FILTER (WHERE c.duration_seconds > 20)::text AS good
         FROM va.calls c WHERE c.deal_id IN (SELECT d.deal_id FROM sa.deals d WHERE ${where})`,
      [id],
    ),
    db.query<{ mgr: string; name: string | null; deals: number; sold: number; first_at: Date; last_at: Date }>(
      `SELECT t.mgr, coalesce(h.name, org.manager_name) AS name, t.deals, t.sold, t.first_at, t.last_at
         FROM (
           SELECT d.current_manager_id::text AS mgr, count(*)::int AS deals,
                  count(*) FILTER (WHERE d.sold_at IS NOT NULL)::int AS sold,
                  min(d.created_at) AS first_at, max(d.created_at) AS last_at
             FROM sa.deals d WHERE ${where} AND d.funnel_id IN (0,1,2,3) AND d.current_manager_id IS NOT NULL
            GROUP BY 1
         ) t
         LEFT JOIN LATERAL (
           SELECT name FROM sa.employee_name_history nh
            WHERE nh.bitrix_user_id = t.mgr AND nh.valid_from <= t.last_at AND (nh.valid_to IS NULL OR nh.valid_to > t.last_at)
            ORDER BY nh.valid_from DESC LIMIT 1
         ) h ON true
         LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = t.mgr
        ORDER BY t.last_at DESC`,
      [id],
    ),
  ]);
  return {
    purchases: purchases.rows.map(r => ({
      dealId: Number(r.deal_id), dealName: r.deal_name, amount: Number(r.amount ?? 0),
      deliveredAt: new Date(r.delivered_at).toISOString(), headGroup: r.head_group_name, kcCategory: r.kc_name,
      groups: r.groups ?? [],
    })),
    calls: calls.rows.map(c => {
      const sec = Number(c.duration_seconds ?? 0);
      return {
        calledAt: new Date(c.called_at).toISOString(), durationSec: sec,
        direction: c.direction === 'inbound' || c.direction === 'outbound' ? c.direction : null,
        missed: c.result === 'missed' || sec === 0, dealId: c.deal_id !== null ? Number(c.deal_id) : null,
        managerName: c.manager_name,
      };
    }),
    callsTotal: Number(totals.rows[0]?.total ?? 0),
    goodCallsTotal: Number(totals.rows[0]?.good ?? 0),
    managers: managers.rows.map(m => ({
      managerId: m.mgr, name: m.name, deals: m.deals, sold: m.sold,
      firstAt: new Date(m.first_at).toISOString(), lastAt: new Date(m.last_at).toISOString(),
    })),
  };
}
