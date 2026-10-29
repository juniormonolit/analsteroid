// «Аналитика канбана повторных» → вкладка «Пул и скорость» (владелец 26.10: «сколько зависло, как быстро
// принимается и разбирается»; проект экрана — Fable). По менеджеру (ответственному задачи), дерево — на клиенте.
//
// Остатки — ТЕКУЩЕЕ состояние (не зависят от периода):
//   * ждут приёмки — задачи проекта 118 в статусе 4 «ждёт контроля»; ожидание — now − changed_at (истории
//     статусов в копии нет: changed_at у задачи «ждёт контроля» ≈ момент сдачи, отсюда «≈»);
//   * зависло — открытые задачи (статус 1–3, 6) со сроком в прошлом; «больше 7 дней» — срок прошёл неделю назад;
//   * в очереди — repeat_task_queue status = 'queued'.
// Потоки — за период:
//   * принято — задачи завершены (status 5, closed_at в периоде); вернули — task_returned журнала канбана (с 23.10,
//     возвраты прямо в Битриксе не видны);
//   * разбор отказа — reject_reviewed журнала: часы от закрытия сделки в отказ (sa.deals.lost_at) до решения РОПа.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { REPEAT_PROJECT_GROUP_ID } from './config';
import { fetchManagerDirectory, fetchOrg, periodBounds, type MgrInfo, type OrgNode, type Period } from './saLookups';

export interface SpeedMgr {
  managerId: string;
  control: number; controlWaitH: number[];
  overdue: number; overdue7: number; open: number;
  /** Открытые по статусу Битрикса (вкладка «Задачи», 29.10): не начата (1–2), в работе (3), отложена (6). */
  notStarted: number; inProgress: number; deferred: number;
  accepted: number; returned: number;
  reviews: number; reviewH: number[];
  queued: number;
}
export interface KanbanSpeed { fromDate: string; period: Period; mgr: SpeedMgr[]; managers: Record<string, MgrInfo>; org: OrgNode[] }

export async function fetchKanbanSpeed(opts: { date: string; period: Period; managerIds: string[] | null }): Promise<KanbanSpeed> {
  const { fromDate, from, to } = periodBounds(opts.date, opts.period);
  const mf = opts.managerIds;
  const now = Date.now();
  const [tasks, closed, events, queue, directory, org] = await Promise.all([
    analyticsDb().query<{ rid: string; status: number; changed_at: Date | null; deadline_at: Date | null }>(
      `SELECT responsible_id::text AS rid, status, changed_at, deadline_at FROM sa.bitrix_task_current
        WHERE group_id = $1 AND NOT is_deleted AND status IN (1, 2, 3, 4, 6) ${mf ? 'AND responsible_id::text = ANY($2::text[])' : ''}`,
      mf ? [REPEAT_PROJECT_GROUP_ID, mf] : [REPEAT_PROJECT_GROUP_ID]).then(r => r.rows),
    analyticsDb().query<{ rid: string; n: string }>(
      `SELECT responsible_id::text AS rid, count(*)::text AS n FROM sa.bitrix_task_current
        WHERE group_id = $1 AND NOT is_deleted AND status = 5 AND closed_at BETWEEN $2::timestamptz AND $3::timestamptz
        ${mf ? 'AND responsible_id::text = ANY($4::text[])' : ''} GROUP BY 1`,
      mf ? [REPEAT_PROJECT_GROUP_ID, from, to, mf] : [REPEAT_PROJECT_GROUP_ID, from, to]).then(r => r.rows),
    systemDb().query<{ manager_id: string | null; event_type: string; deal_id: string | null; ts: Date }>(
      `SELECT manager_id, event_type, deal_id::text, ts FROM repeat_kanban_events
        WHERE event_type IN ('task_returned', 'reject_reviewed') AND ts BETWEEN $1::timestamptz AND $2::timestamptz
        ${mf ? 'AND manager_id = ANY($3::text[])' : ''}`, mf ? [from, to, mf] : [from, to]).then(r => r.rows),
    systemDb().query<{ manager_id: string; n: string }>(
      `SELECT coalesce(new_responsible_id, manager_id) AS manager_id, count(*)::text AS n FROM repeat_task_queue
        WHERE status = 'queued' GROUP BY 1`).then(r => r.rows),
    fetchManagerDirectory(),
    fetchOrg(),
  ]);
  const lostIds = [...new Set(events.filter(e => e.event_type === 'reject_reviewed' && e.deal_id).map(e => Number(e.deal_id)))];
  const lost = lostIds.length ? new Map((await analyticsDb().query<{ deal_id: string; lost_at: Date | null }>(
    `SELECT deal_id::text, lost_at FROM sa.deals WHERE deal_id = ANY($1::bigint[])`, [lostIds])).rows.map(r => [Number(r.deal_id), r.lost_at])) : new Map<number, Date | null>();

  const by = new Map<string, SpeedMgr>();
  const get = (id: string | null) => {
    const k = id ?? '—';
    let m = by.get(k);
    if (!m) { m = { managerId: k, control: 0, controlWaitH: [], overdue: 0, overdue7: 0, open: 0, notStarted: 0, inProgress: 0, deferred: 0, accepted: 0, returned: 0, reviews: 0, reviewH: [], queued: 0 }; by.set(k, m); }
    return m;
  };
  const H = 3_600_000;
  for (const t of tasks) {
    const m = get(t.rid);
    if (Number(t.status) === 4) { m.control++; if (t.changed_at) m.controlWaitH.push(Math.round((now - new Date(t.changed_at).getTime()) / H)); continue; }
    m.open++;
    const st = Number(t.status);
    if (st === 3) m.inProgress++; else if (st === 6) m.deferred++; else m.notStarted++;
    const dl = t.deadline_at ? new Date(t.deadline_at).getTime() : null;
    if (dl !== null && dl < now) { m.overdue++; if (dl < now - 7 * 24 * H) m.overdue7++; }
  }
  for (const c of closed) get(c.rid).accepted += Number(c.n);
  for (const e of events) {
    const m = get(e.manager_id);
    if (e.event_type === 'task_returned') { m.returned++; continue; }
    m.reviews++;
    const l = e.deal_id ? lost.get(Number(e.deal_id)) : null;
    if (l) { const h = Math.round((new Date(e.ts).getTime() - new Date(l).getTime()) / H); if (h >= 0) m.reviewH.push(h); }
  }
  for (const q of queue) if (!mf || mf.includes(q.manager_id)) get(q.manager_id).queued += Number(q.n);

  const mgr = [...by.values()].filter(m => m.managerId !== '—');
  const managers: Record<string, MgrInfo> = {};
  for (const m of mgr) managers[m.managerId] = directory.get(m.managerId) ?? { name: `#${m.managerId}`, deptId: null };
  return { fromDate, period: opts.period, mgr, managers, org };
}
