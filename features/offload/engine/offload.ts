import { analyticsDb } from '@/lib/db/clients';
import type { DealScope } from '@/lib/metrics/types';
import { cutoffForHeadGroup } from './cutoffs';
import { getOffloadModel, probabilityFor } from './model';

// «Разгрузка отделов» (задача 2635, этап 1, read-only) — снимок ОТКРЫТЫХ сделок
// в стадиях NEW и WORK с деревом отдел → менеджер → сделки и оценкой «мёртвости».
//
// Определения (сверены со снимком «Сейчас в стадии», stageSnapshot.ts):
//  * NEW  — текущая стадия d.stage_id со stage_type='NEW' (та же семантика, что
//    метрика «Необработанные» stage_now_unprocessed_count, но по ВСЕМ воронкам —
//    NEW-стадии есть только в 0..3, поэтому числа совпадают при том же фильтре).
//  * WORK — stage_type='WORK' БЕЗ event_type IN ('sold','shipped'): стадии
//    «Продано/Заказ оплачен» бизнес держит в WORK (см. комментарий в
//    stageSnapshot.ts про deals_in_work), но инструменту разгрузки оплаченные
//    заказы не нужны — их не закрывают. Поэтому наш work =
//    deals_in_work_count_* МИНУС сделки sold/shipped-стадий (сверка в отчёте).
//  * Открытость гарантируется самой стадией (WON/LOSS — другие stage_type).
//
// Период НЕ применяется (решение по ТЗ): список — ТЕКУЩИЕ открытые сделки,
// снимок живого d.stage_id (как у stageSnapshot). Применимые фильтры: воронка
// (перв./повт./все — та же семантика f.is_repeat, что в отчётах), отделы,
// «Чек от/до» (d.amount, как в разделе «Графики»).

export interface OffloadFilters {
  dealScope?: DealScope;          // default 'all'
  departmentIds?: string[];       // bitrix_department_id, как в отчётах
  amountFrom?: number;
  amountTo?: number;
}

export interface OffloadDealRow {
  dealId: number;
  dealName: string;
  amount: number;
  stageGroup: 'new' | 'work';
  stageName: string;
  kcGroup: string;                // товарная группа по КЦ (product_groups.name)
  headGroup: string;              // шкала модели/отсечек (head_group_name)
  isRepeat: boolean;
  workDays: number;               // накопленные рабочие дни (механика графиков)
  pricedStagnantDays: number | null; // дней в «Созвонился и озвучил цены» без смены стадии (по deal_events; история с 03.04.2026)
  medianSaleDays: number | null;  // медианы ГРУППЫ (head_group, модель)
  medianLossDays: number | null;
  medianCloseDays: number | null;
  probability: number | null;     // P(продажа | дожила); null для повторки (модель только первичка)
  cutoffDays: number;
  daysOverCutoff: number;         // max(0, workDays - cutoff)
  recommended: boolean;           // первичка && workDays > cutoff группы
  deadScore: number;              // daysOverCutoff * amount — сортировка «самые мёртвые сверху»
  managerId: string;
  managerName: string;
}

export interface OffloadManagerNode {
  managerId: string;
  managerName: string;
  shortLogin: string | null;
  newCount: number;
  workCount: number;
  totalAmount: number;
  recommendedCount: number;
  recommendedAmount: number;
  // для глобальной кнопки «выделить рекомендованные» без раскрытия менеджера
  recommendedDeals: { dealId: number; amount: number; probability: number | null }[];
}

export interface OffloadDepartmentNode {
  departmentId: string;
  departmentName: string;
  branch: string | null;
  managers: OffloadManagerNode[];
  newCount: number;
  workCount: number;
  totalCount: number;
  totalAmount: number;           // доп-метрика (решение): Σ amount открытых сделок отдела
  recommendedCount: number;      // доп-метрика (решение): сделок за отсечкой
  recommendedAmount: number;
  avgPerManager: number;         // (work+new) / число менеджеров отдела с открытыми сделками
}

export interface OffloadTree {
  departments: OffloadDepartmentNode[];
  totals: { newCount: number; workCount: number; totalCount: number; totalAmount: number; recommendedCount: number; recommendedAmount: number };
  modelComputedAt: number;
}

interface RawDealRow {
  deal_id: number;
  deal_name: string | null;
  amount: string | null;
  stage_group: 'new' | 'work';
  stage_name: string | null;
  kc_group: string | null;
  head_group: string | null;
  is_repeat: boolean;
  manager_id: string | null;
  work_days: string | null;
  priced_since: string | null;   // event_at последнего события, если тек. стадия «Созвонился и озвучил цены»
  is_priced_stage: boolean;
}

function scopeWhereSql(dealScope: DealScope | undefined): string {
  if (dealScope === 'primary') return 'AND f.is_repeat = false';
  if (dealScope === 'repeat') return 'AND f.is_repeat = true';
  return '';
}

// Старт истории deal_events — у сделок без единого события «стоит без изменений»
// считаем с этой даты (согласовано в ТЗ: «у старых сделок — с начала истории»).
const EVENTS_START_MS = Date.parse('2026-04-03T00:00:00+03:00');

async function fetchOpenDeals(filters: OffloadFilters): Promise<RawDealRow[]> {
  const params: unknown[] = [];
  let deptWhere = '';
  if (filters.departmentIds?.length) {
    params.push(filters.departmentIds);
    deptWhere = `AND d.current_manager_id::text IN (
      SELECT orh.manager_bitrix_user_id FROM sa.org_resolved_hierarchy orh
      WHERE orh.department_id IN (SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($${params.length}))
        AND orh.is_active = true)`;
  }
  let amtWhere = '';
  if (filters.amountFrom !== undefined && Number.isFinite(filters.amountFrom)) {
    params.push(filters.amountFrom);
    amtWhere += ` AND d.amount >= $${params.length}`;
  }
  if (filters.amountTo !== undefined && Number.isFinite(filters.amountTo)) {
    params.push(filters.amountTo);
    amtWhere += ` AND d.amount <= $${params.length}`;
  }

  // work_days: та же механика, что fetchWorkRows (stageSurvival.ts) — сумма
  // интервалов «событие WORK-стадии → следующее событие», хвост открытой стадии
  // до now(). Здесь считается ТОЛЬКО по открытым сделкам снимка (подзапрос по
  // ним же), а не по всей истории — дешевле, чем полный когортный агрегат.
  const sql = `
WITH open_deals AS (
  SELECT d.deal_id, d.deal_name, d.amount, d.stage_id, d.head_group_name,
         d.product_group_id, d.current_manager_id, f.is_repeat,
         CASE WHEN s.stage_type = 'NEW' THEN 'new' ELSE 'work' END AS stage_group,
         s.name AS stage_name,
         (s.name ILIKE 'Созвонился и озвучил%') AS is_priced_stage
  FROM deals d
  JOIN stages s ON s.id = d.stage_id
  JOIN funnels f ON f.id = d.funnel_id
  WHERE (s.stage_type = 'NEW'
         OR (s.stage_type = 'WORK' AND s.event_type NOT IN ('sold','shipped')))
    ${scopeWhereSql(filters.dealScope)} ${deptWhere} ${amtWhere}
),
work_stages AS (
  SELECT id FROM stages WHERE stage_type = 'WORK' AND event_type NOT IN ('sold','shipped')
),
ev AS (
  SELECT de.deal_id, de.stage_id, de.event_at,
         LEAD(de.event_at) OVER (PARTITION BY de.deal_id ORDER BY de.event_at) AS next_at
  FROM deal_events de
  WHERE de.deal_id IN (SELECT deal_id FROM open_deals)
),
wt AS (
  SELECT ev.deal_id,
         SUM(EXTRACT(EPOCH FROM COALESCE(ev.next_at, now()) - ev.event_at)) / 86400.0 AS work_days
  FROM ev JOIN work_stages ws ON ws.id = ev.stage_id
  GROUP BY ev.deal_id
),
last_ev AS (
  SELECT deal_id, MAX(event_at) AS last_at FROM ev GROUP BY deal_id
)
SELECT od.deal_id, od.deal_name, od.amount, od.stage_group, od.stage_name,
       pg.name AS kc_group, od.head_group_name AS head_group, od.is_repeat,
       od.current_manager_id::text AS manager_id,
       COALESCE(wt.work_days, 0) AS work_days,
       le.last_at AS priced_since,
       od.is_priced_stage
FROM open_deals od
LEFT JOIN product_groups pg ON pg.id = od.product_group_id
LEFT JOIN wt ON wt.deal_id = od.deal_id
LEFT JOIN last_ev le ON le.deal_id = od.deal_id
  `.trim();

  const res = await analyticsDb().query<RawDealRow>(sql, params);
  return res.rows;
}

interface OrgManager { managerId: string; managerName: string; shortLogin: string | null; departmentId: string | null; departmentName: string | null; branch: string | null }

async function fetchOrg(): Promise<Map<string, OrgManager>> {
  const res = await analyticsDb().query<{
    manager_bitrix_user_id: string; manager_name: string; short_login: string | null;
    department_id: string | null; department_name: string | null; branch: string | null;
  }>(`SELECT manager_bitrix_user_id, manager_name, short_login, department_id, department_name, branch
      FROM sa.org_resolved_hierarchy WHERE is_active = true`);
  const map = new Map<string, OrgManager>();
  for (const r of res.rows) {
    map.set(r.manager_bitrix_user_id, {
      managerId: r.manager_bitrix_user_id,
      managerName: r.manager_name,
      shortLogin: r.short_login,
      departmentId: r.department_id,
      departmentName: r.department_name,
      branch: r.branch,
    });
  }
  return map;
}

function toDealRow(r: RawDealRow, model: Awaited<ReturnType<typeof getOffloadModel>>, org: Map<string, OrgManager>): OffloadDealRow {
  const amount = Number(r.amount ?? 0) || 0;
  const workDays = Math.max(0, Number(r.work_days ?? 0));
  const headGroup = r.head_group && r.head_group !== '' ? r.head_group : '(без группы)';
  const gm = model.byGroup.get(headGroup) ?? model.overall;
  const cutoff = cutoffForHeadGroup(r.head_group);
  const probability = r.is_repeat ? null : probabilityFor(model, r.head_group, workDays);
  // рекомендация и «дни за отсечкой» — только первичка (модель отчёта; повторку
  // отчёт прямо запрещает резать этой отсечкой)
  const daysOver = r.is_repeat ? 0 : Math.max(0, workDays - cutoff);
  let pricedStagnantDays: number | null = null;
  if (r.is_priced_stage) {
    // pg отдаёт timestamptz как Date-объект — new Date() принимает оба варианта
    const sinceMs = r.priced_since ? new Date(r.priced_since as unknown as string | Date).getTime() : EVENTS_START_MS;
    pricedStagnantDays = Math.max(0, Math.floor((Date.now() - sinceMs) / 86_400_000));
  }
  const mgr = r.manager_id ? org.get(r.manager_id) : undefined;
  return {
    dealId: Number(r.deal_id),
    dealName: r.deal_name ?? `Сделка #${r.deal_id}`,
    amount,
    stageGroup: r.stage_group,
    stageName: r.stage_name ?? '—',
    kcGroup: r.kc_group ?? 'Без группы',
    headGroup,
    isRepeat: r.is_repeat,
    workDays: Math.round(workDays * 10) / 10,
    pricedStagnantDays,
    medianSaleDays: gm.medianSaleDays,
    medianLossDays: gm.medianLossDays,
    medianCloseDays: gm.medianCloseDays,
    probability,
    cutoffDays: cutoff,
    daysOverCutoff: Math.round(daysOver * 10) / 10,
    recommended: !r.is_repeat && daysOver > 0,
    deadScore: daysOver * amount,
    managerId: r.manager_id ?? '0',
    managerName: mgr?.managerName ?? `#${r.manager_id ?? '—'}`,
  };
}

// Кэш снимка на 60с по ключу фильтров — дерево и раскрытие менеджеров бьют в
// один и тот же расчёт, без кэша каждое раскрытие гоняло бы полный SQL.
const snapCache = new Map<string, { at: number; rows: OffloadDealRow[]; org: Map<string, OrgManager> }>();
const SNAP_TTL_MS = 60_000;

export async function getOffloadDeals(filters: OffloadFilters): Promise<{ rows: OffloadDealRow[]; org: Map<string, OrgManager> }> {
  const key = JSON.stringify([filters.dealScope ?? 'all', filters.departmentIds ?? [], filters.amountFrom ?? null, filters.amountTo ?? null]);
  const hit = snapCache.get(key);
  if (hit && Date.now() - hit.at < SNAP_TTL_MS) return hit;
  const [raw, model, org] = await Promise.all([fetchOpenDeals(filters), getOffloadModel(), fetchOrg()]);
  const rows = raw.map(r => toDealRow(r, model, org));
  const entry = { at: Date.now(), rows, org };
  snapCache.set(key, entry);
  if (snapCache.size > 20) {
    const oldest = [...snapCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) snapCache.delete(oldest[0]);
  }
  return entry;
}

export async function buildOffloadTree(filters: OffloadFilters): Promise<OffloadTree> {
  const { rows, org } = await getOffloadDeals(filters);
  const model = await getOffloadModel();

  const byManager = new Map<string, OffloadDealRow[]>();
  for (const r of rows) {
    const arr = byManager.get(r.managerId) ?? [];
    arr.push(r);
    byManager.set(r.managerId, arr);
  }

  const byDept = new Map<string, { name: string; branch: string | null; managers: OffloadManagerNode[] }>();
  for (const [managerId, deals] of byManager) {
    const o = org.get(managerId);
    const deptId = o?.departmentId ?? '__none__';
    const deptName = o?.departmentName ?? 'Вне оргструктуры';
    const rec = deals.filter(d => d.recommended);
    const node: OffloadManagerNode = {
      managerId,
      managerName: deals[0].managerName,
      shortLogin: o?.shortLogin ?? null,
      newCount: deals.filter(d => d.stageGroup === 'new').length,
      workCount: deals.filter(d => d.stageGroup === 'work').length,
      totalAmount: deals.reduce((s, d) => s + d.amount, 0),
      recommendedCount: rec.length,
      recommendedAmount: rec.reduce((s, d) => s + d.amount, 0),
      recommendedDeals: rec.map(d => ({ dealId: d.dealId, amount: d.amount, probability: d.probability })),
    };
    const dept = byDept.get(deptId) ?? { name: deptName, branch: o?.branch ?? null, managers: [] };
    dept.managers.push(node);
    byDept.set(deptId, dept);
  }

  const departments: OffloadDepartmentNode[] = [...byDept.entries()].map(([departmentId, d]) => {
    const managers = d.managers.sort((a, b) => (b.newCount + b.workCount) - (a.newCount + a.workCount));
    const newCount = managers.reduce((s, m) => s + m.newCount, 0);
    const workCount = managers.reduce((s, m) => s + m.workCount, 0);
    const totalCount = newCount + workCount;
    return {
      departmentId,
      departmentName: d.name,
      branch: d.branch,
      managers,
      newCount,
      workCount,
      totalCount,
      totalAmount: managers.reduce((s, m) => s + m.totalAmount, 0),
      recommendedCount: managers.reduce((s, m) => s + m.recommendedCount, 0),
      recommendedAmount: managers.reduce((s, m) => s + m.recommendedAmount, 0),
      avgPerManager: managers.length ? Math.round((totalCount / managers.length) * 10) / 10 : 0,
    };
  }).sort((a, b) => b.totalCount - a.totalCount);

  return {
    departments,
    totals: {
      newCount: departments.reduce((s, d) => s + d.newCount, 0),
      workCount: departments.reduce((s, d) => s + d.workCount, 0),
      totalCount: departments.reduce((s, d) => s + d.totalCount, 0),
      totalAmount: departments.reduce((s, d) => s + d.totalAmount, 0),
      recommendedCount: departments.reduce((s, d) => s + d.recommendedCount, 0),
      recommendedAmount: departments.reduce((s, d) => s + d.recommendedAmount, 0),
    },
    modelComputedAt: model.computedAt,
  };
}

export type StageMode = 'both' | 'work' | 'new';

/** Сделки одного менеджера, «самые мёртвые сверху» (дни за отсечкой × сумма). */
export async function getManagerDeals(filters: OffloadFilters, managerId: string, stageMode: StageMode): Promise<OffloadDealRow[]> {
  const { rows } = await getOffloadDeals(filters);
  return rows
    .filter(r => r.managerId === managerId)
    .filter(r => stageMode === 'both' || r.stageGroup === stageMode)
    .sort((a, b) => b.deadScore - a.deadScore || b.workDays - a.workDays || b.amount - a.amount);
}
