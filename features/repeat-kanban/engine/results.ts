// «Результат» канбана повторных — воронка задача → отгрузка (решение владельца 21.10:
// «результат задачи — только СЛЕДУЮЩАЯ отгрузка заказчика после постановки; после неё
// заказчик снова в пуле, и цикл начинается заново»).
//
// Задача = задача Битрикса проекта «Повторные продажи» (гр. 118), созданная в периоде, — и
// поставленная из канбана, и прямо в Битриксе/старым канбаном (sa.bitrix_task_current — одна
// копия на всех). Менеджер — ответственный задачи. Заказчик — по сделке задачи, привязкой
// доски (saLookups.refOfDeal: юр-сделка без компании → контакт).
//
// Этапы (каждый — от created_at задачи):
//   * Дозвонились — звонок > 20 с (не «missed») по СДЕЛКЕ задачи, как reached на доске;
//   * Продано — первая продажа (sold_at) ЛЮБОЙ сделки заказчика в воронках 0–3 после задачи,
//     но не позже следующей отгрузки (после неё — уже следующий цикл). Любой сделки, а не
//     только сделки задачи: менеджер часто оформляет заказ новой сделкой/в первичной воронке,
//     а владелец мыслит «задача → результат заказчика», не «задача → её сделка»;
//   * Отгружено — первая отгрузка (delivered_at) любой сделки заказчика в воронках 0–3 после
//     задачи, сумма — amount этой сделки, дни — от постановки до отгрузки. preSold — сделка
//     отгрузки продана ДО задачи (заказ уже был в работе): отгрузку засчитываем по правилу
//     владельца, но показываем, сколько таких, чтобы результат не приписывался задаче вслепую.
//
// Несколько задач по одному заказчику до одной отгрузки: отгрузку получает ПОСЛЕДНЯЯ задача
// перед ней, ранние помечаются superseded («перепоставлена») и выпадают из базы конверсий.
// Почему последняя: перепоставляют, когда прежняя задача не сработала (сменили менеджера,
// просрочили, закрыли без результата) — отгрузку довёл тот, у кого задача была на руках, и
// «задача → следующая отгрузка» без разрыва верна именно для неё. Ранние задачи цикла остаются
// в «поставлено» (работа РОПа видна), но не размывают конверсию — иначе каждая перепостановка
// роняла бы % отдела, не меняя результата.
//
// Свежие задачи: отгрузка ещё не могла наступить, поэтому конверсии «продано» и «отгружено»
// считаются по ЗРЕЛЫМ задачам (старше MATURE_DAYS) с исходом в пределах тех же MATURE_DAYS —
// честная когорта; остальное — «в процессе». Счётчики «отгружено шт/₽» — по всем задачам.
import { analyticsDb } from '@/lib/db/clients';
import { REPEAT_PROJECT_GROUP_ID } from './config';
import {
  fetchDealsById, fetchManagerDirectory, fetchOrg, periodBounds, refOfDeal,
  type MgrInfo, type OrgNode, type Period,
} from './saLookups';

/** Сколько дней ждём исхода задачи: окно повторной продажи 22 дня + время на отгрузку. */
export const MATURE_DAYS = 30;
const DAY_MS = 86_400_000;
const GOOD_CALL_SEC = 20;

export interface ResultTask {
  taskId: number;
  dealId: number | null;
  managerId: string | null;
  createdAt: string;
  /** Ключ заказчика: k<компания> | p<контакт> (см. refOfDeal). */
  clientRef: string | null;
  reachedAt: string | null;
  soldAt: string | null;
  /** Сумма проданной сделки (первая продажа после задачи; 26.10 — «конверсия в суммах»). */
  soldAmount: number | null;
  shippedAt: string | null;
  shippedAmount: number | null;
  shippedDealId: number | null;
  /** Сделка отгрузки продана до постановки задачи. */
  preSold: boolean;
  /** Перепоставлена: позже, до следующей отгрузки, по заказчику поставили другую задачу. */
  superseded: boolean;
  /** Возраст задачи ≥ MATURE_DAYS — исход «продано/отгружено за 30 дн.» уже известен. */
  mature: boolean;
}

export interface KanbanResults {
  date: string; fromDate: string; period: Period; generatedAt: string; matureDays: number;
  tasks: ResultTask[];
  managers: Record<string, MgrInfo>;
  org: OrgNode[];
}

interface ShipRow { at: number; amount: number; dealId: number; soldAt: number | null }

export async function fetchKanbanResults(opts: { date: string; period: Period; managerIds: string[] | null }): Promise<KanbanResults> {
  const { fromDate, from, to } = periodBounds(opts.date, opts.period);
  const now = Date.now();
  const toMs = new Date(to).getTime();
  const db = analyticsDb();

  // 1. Задачи проекта с начала периода ПО СЕЙЧАС: более поздние нужны, чтобы понять, что
  // задача периода перепоставлена. Индекс (group_id, created_at).
  const [taskRows, directory, org] = await Promise.all([
    db.query<{ task_id: string; deal_id: string | null; responsible_id: string | null; created_at: Date }>(
      `SELECT task_id, deal_id, responsible_id::text AS responsible_id, created_at
         FROM sa.bitrix_task_current
        WHERE group_id = $1 AND NOT is_deleted AND created_at >= $2::timestamptz`,
      [REPEAT_PROJECT_GROUP_ID, from],
    ).then(r => r.rows),
    fetchManagerDirectory(),
    fetchOrg(),
  ]);
  const taskDealIds = [...new Set(taskRows.map(t => (t.deal_id !== null ? Number(t.deal_id) : 0)).filter(Boolean))];
  const dealRefs = await fetchDealsById(taskDealIds);

  const companies = new Set<number>(), contacts = new Set<number>();
  const refOfTask = new Map<number, string | null>();
  for (const t of taskRows) {
    const d = t.deal_id !== null ? dealRefs.get(Number(t.deal_id)) : undefined;
    const ref = d ? refOfDeal(d) : null;
    refOfTask.set(Number(t.task_id), ref);
    if (ref?.startsWith('k')) companies.add(Number(ref.slice(1)));
    else if (ref?.startsWith('p')) contacts.add(Number(ref.slice(1)));
  }

  // 2. Продажи и отгрузки заказчиков после начала периода — один проход по sa.deals.
  // 3. Дозвоны по сделкам задач (va.calls по deal_id, как fetchDealCalls доски).
  const [custDeals, calls] = await Promise.all([
    companies.size || contacts.size ? db.query<{ deal_id: string; funnel_id: number; company_id: string | null; contact_id: string | null; sold_at: Date | null; delivered_at: Date | null; amount: string | null }>(
      `SELECT d.deal_id, d.funnel_id, d.company_id, d.contact_id, d.sold_at, d.delivered_at, d.amount
         FROM sa.deals d
        WHERE d.funnel_id IN (0,1,2,3)
          AND (d.company_id = ANY($1::bigint[]) OR d.contact_id = ANY($2::bigint[]))
          AND (d.sold_at >= $3::timestamptz OR d.delivered_at >= $3::timestamptz)`,
      [[...companies], [...contacts], from],
    ).then(r => r.rows) : Promise.resolve([]),
    taskDealIds.length ? db.query<{ deal_id: string; called_at: Date }>(
      `SELECT deal_id, called_at FROM va.calls
        WHERE deal_id = ANY($1::bigint[]) AND called_at >= $2::timestamptz
          AND failed_at_stage IS NULL
          AND duration_seconds > ${GOOD_CALL_SEC} AND result IS DISTINCT FROM 'missed'`,
      [taskDealIds, from],
    ).then(r => r.rows).catch(() => []) : Promise.resolve([]),
  ]);

  const ships = new Map<string, ShipRow[]>(), sales = new Map<string, { at: number; amount: number }[]>();
  for (const d of custDeals) {
    const ref = refOfDeal({ funnelId: Number(d.funnel_id), companyId: d.company_id !== null ? Number(d.company_id) : null, contactId: d.contact_id !== null ? Number(d.contact_id) : null });
    if (!ref) continue;
    const soldMs = d.sold_at ? new Date(d.sold_at).getTime() : null;
    if (d.delivered_at) {
      const l = ships.get(ref) ?? [];
      l.push({ at: new Date(d.delivered_at).getTime(), amount: Math.round(Number(d.amount ?? 0)), dealId: Number(d.deal_id), soldAt: soldMs });
      ships.set(ref, l);
    }
    if (soldMs !== null) { const l = sales.get(ref) ?? []; l.push({ at: soldMs, amount: Math.round(Number(d.amount ?? 0)) }); sales.set(ref, l); }
  }
  for (const l of ships.values()) l.sort((a, b) => a.at - b.at || a.dealId - b.dealId);
  for (const l of sales.values()) l.sort((a, b) => a.at - b.at);
  const callsByDeal = new Map<number, number[]>();
  for (const c of calls) { const l = callsByDeal.get(Number(c.deal_id)) ?? []; l.push(new Date(c.called_at).getTime()); callsByDeal.set(Number(c.deal_id), l); }
  for (const l of callsByDeal.values()) l.sort((a, b) => a - b);

  // Задачи заказчика по времени — для «перепоставлена».
  const tasksOfRef = new Map<string, { id: number; at: number }[]>();
  for (const t of taskRows) {
    const ref = refOfTask.get(Number(t.task_id));
    if (!ref) continue;
    const l = tasksOfRef.get(ref) ?? []; l.push({ id: Number(t.task_id), at: new Date(t.created_at).getTime() }); tasksOfRef.set(ref, l);
  }

  const mf = opts.managerIds ? new Set(opts.managerIds) : null;
  const iso = (ms: number | null | undefined) => (ms != null ? new Date(ms).toISOString() : null);
  const tasks: ResultTask[] = [];
  for (const t of taskRows) {
    const at = new Date(t.created_at).getTime();
    if (at > toMs) continue; // позже периода — нужна была только для перепостановки
    if (mf && (!t.responsible_id || !mf.has(t.responsible_id))) continue;
    const id = Number(t.task_id);
    const dealId = t.deal_id !== null ? Number(t.deal_id) : null;
    const ref = refOfTask.get(id) ?? null;
    const ship = ref ? (ships.get(ref) ?? []).find(s => s.at > at) ?? null : null;
    const sale = ref ? (sales.get(ref) ?? []).find(s => s.at > at && (!ship || s.at <= ship.at)) ?? null : null;
    const soldMs = sale?.at ?? null;
    const reachedMs = dealId ? (callsByDeal.get(dealId) ?? []).find(c => c >= at) ?? null : null;
    const superseded = !!ref && (tasksOfRef.get(ref) ?? []).some(o => o.id !== id
      && (o.at > at || (o.at === at && o.id > id)) && (!ship || o.at < ship.at));
    tasks.push({
      taskId: id, dealId, managerId: t.responsible_id, createdAt: iso(at)!, clientRef: ref,
      reachedAt: iso(reachedMs), soldAt: iso(soldMs), soldAmount: sale?.amount ?? null,
      shippedAt: iso(ship?.at), shippedAmount: ship?.amount ?? null, shippedDealId: ship?.dealId ?? null,
      preSold: !!ship && ship.soldAt !== null && ship.soldAt <= at,
      superseded, mature: now - at >= MATURE_DAYS * DAY_MS,
    });
  }

  // Менеджеры задач — имя и отдел для дерева (только нужные, не весь справочник).
  const managers: Record<string, MgrInfo> = {};
  for (const t of tasks) if (t.managerId && !managers[t.managerId]) managers[t.managerId] = directory.get(t.managerId) ?? { name: `#${t.managerId}`, deptId: null };
  return { date: opts.date, fromDate, period: opts.period, generatedAt: new Date(now).toISOString(), matureDays: MATURE_DAYS, tasks, managers, org };
}
