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

/** Задача по сделке клиента (владелец 23.10: «хронология сделок и задач по клиенту — какие задачи ставились, когда
 *  и какой у них результат»). state — как на канбане; result — последний формальный «Результат» задачи. */
export interface HistoryTask {
  taskId: number; dealId: number | null; title: string; state: 'new' | 'in_progress' | 'control' | 'done' | 'deferred' | 'declined';
  createdAt: string; deadlineAt: string | null; closedAt: string | null;
  createdByName: string | null; responsibleName: string | null; repeat: boolean;
  result: { text: string; at: string | null } | null;
}

export interface ClientHistory {
  purchases: HistoryPurchase[];
  tasks: HistoryTask[];
  calls: HistoryCall[];
  callsTotal: number;
  goodCallsTotal: number;
  managers: HistoryManager[];
}

// 500 последних звонков (вкладка показывает по 100 и «показать ещё», аудит 23.10).
const CALLS_LIMIT = 500;
const TASKS_LIMIT = 300;

const STATE: Record<number, HistoryTask['state']> = { 1: 'new', 2: 'new', 3: 'in_progress', 4: 'control', 5: 'done', 6: 'deferred', 7: 'declined' };
const clip = (s: string) => s.replace(/\[(USER|URL)[^\]]*\]([\s\S]*?)\[\/\1\]/gi, '$2').replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 400);

/** Задачи по сделкам клиента: привязка в копии Битрикса И наши записи (журнал канбана, очередь) — синк часто
 *  пишет задачу без deal_id (tasks.ts linkedTasks, 23.10). */
async function fetchClientTasks(where: string, id: number): Promise<HistoryTask[]> {
  const db = analyticsDb();
  const deals = await db.query<{ deal_id: string }>(`SELECT d.deal_id::text FROM sa.deals d WHERE ${where}`, [id]);
  const dealIds = deals.rows.map(r => Number(r.deal_id));
  if (!dealIds.length) return [];
  const { systemDb } = await import('@/lib/db/clients');
  const linked = await systemDb().query<{ task_id: string; deal_id: string }>(
    `SELECT task_id::text, deal_id::text FROM repeat_kanban_events WHERE task_id IS NOT NULL AND deal_id = ANY($1::bigint[])
     UNION SELECT issued_task_id::text, issued_deal_id::text FROM repeat_task_queue WHERE issued_task_id IS NOT NULL AND issued_deal_id = ANY($1::bigint[])`,
    [dealIds],
  ).catch(() => ({ rows: [] as { task_id: string; deal_id: string }[] }));
  const linkDeal = new Map(linked.rows.map(r => [Number(r.task_id), Number(r.deal_id)]));
  const r = await db.query<{ task_id: string; deal_id: string | null; title: string | null; status: number | null; created_at: Date; deadline_at: Date | null; closed_at: Date | null;
    responsible_name: string | null; created_by_name: string | null; group_id: number | null; results: { text?: string; createdAt?: string }[] | null }>(
    `SELECT t.task_id::text, t.deal_id::text, t.title, t.status, t.created_at, t.deadline_at, t.closed_at, t.responsible_name, t.group_id, t.results,
            org.manager_name AS created_by_name
       FROM sa.bitrix_task_current t
       LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = t.created_by::text
      WHERE NOT t.is_deleted AND (t.deal_id = ANY($1::bigint[]) OR t.task_id = ANY($2::bigint[]))
      ORDER BY t.created_at DESC LIMIT ${TASKS_LIMIT}`,
    [dealIds, [...linkDeal.keys()]],
  );
  return r.rows.map(x => {
    const res = (Array.isArray(x.results) ? x.results : []).filter(v => v?.text?.trim()).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
    const taskId = Number(x.task_id);
    return {
      taskId, dealId: x.deal_id !== null ? Number(x.deal_id) : linkDeal.get(taskId) ?? null, title: x.title ?? `Задача #${taskId}`,
      state: STATE[Number(x.status)] ?? 'new', createdAt: new Date(x.created_at).toISOString(),
      deadlineAt: x.deadline_at ? new Date(x.deadline_at).toISOString() : null, closedAt: x.closed_at ? new Date(x.closed_at).toISOString() : null,
      createdByName: x.created_by_name, responsibleName: x.responsible_name, repeat: Number(x.group_id) === 118,
      result: res ? { text: clip(res.text!), at: res.createdAt ? new Date(res.createdAt).toISOString() : null } : null,
    };
  });
}

export async function fetchClientHistory(ref: ClientRef): Promise<ClientHistory> {
  const where = ref.startsWith('k') ? 'd.company_id = $1' : 'd.contact_id = $1';
  const id = Number(ref.slice(1));
  const db = analyticsDb();
  const [purchases, calls, totals, managers, tasks] = await Promise.all([
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
        WHERE c.failed_at_stage IS NULL AND c.deal_id IN (SELECT d.deal_id FROM sa.deals d WHERE ${where})
        ORDER BY c.called_at DESC LIMIT ${CALLS_LIMIT}`,
      [id],
    ),
    db.query<{ total: string; good: string }>(
      `SELECT count(*)::text AS total, count(*) FILTER (WHERE c.duration_seconds > 20)::text AS good
         FROM va.calls c WHERE c.failed_at_stage IS NULL AND c.deal_id IN (SELECT d.deal_id FROM sa.deals d WHERE ${where})`,
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
    fetchClientTasks(where, id).catch(e => { console.warn('[client-card/history] задачи:', e instanceof Error ? e.message : e); return [] as HistoryTask[]; }),
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
    tasks,
    callsTotal: Number(totals.rows[0]?.total ?? 0),
    goodCallsTotal: Number(totals.rows[0]?.good ?? 0),
    managers: managers.rows.map(m => ({
      managerId: m.mgr, name: m.name, deals: m.deals, sold: m.sold,
      firstAt: new Date(m.first_at).toISOString(), lastAt: new Date(m.last_at).toISOString(),
    })),
  };
}
