// Канбан РОПа (пилот, задача #9625) — расчёт колонок на данных схемы sa.
//
// ТОЛЬКО ЧТЕНИЕ: пул analyticsDb() (junior_user, роль без права записи) и одни SELECT'ы.
// В Битрикс ничего не пишется и не вызывается — карточка несёт лишь ссылку на сделку.
// Состав менеджеров — тот же, что у «РОП — сегодня»: scopeRows(ropScope) поверх оргструктуры
// (см. features/tv/engine/dashboard.ts, множество mgrsAll(root)). Логика колонок перенесена из
// MltSalesKanbanService.php (подробности и допущения — в config.ts и в WORKLOG).

import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import type { RopScope } from '@/features/tv/engine/access';
import { scopeRows } from '@/features/tv/engine/dashboard';
import { buildTvTree, deptChains, loadActiveManagers, managersOfNode } from '@/features/tv/engine/orgTree';
import { addDaysStr, mskMidnightIso, mskTodayStr } from '@/features/tv/engine/feed';
import {
  BETTER_PRICE_STAGES, BIG_DEALS_GROUP_IDS, CALLER_ISSUES_GROUP_ID, CARDS_PER_MANAGER, COLUMN_ROW_LIMIT, DEBT_GROUP_ID,
  LOGIST_GROUP_IDS, LOGIST_REQUEST_STAGES, LOGIST_TASK_WINDOW_DAYS, PRIMARY_FUNNEL_IDS, REPEATING_DEALS_GROUP_IDS,
  RESERVED_STAGES, SALE_STAGES, TASKS_ANSWERED, TASKS_OPEN, TASKS_OPEN_OR_CONTROL, TASK_STATUS, UNPROCESSED_STAGES,
  UPD_GROUP_ID, columnsForCycle, dealUrl, taskUrl, type ColumnKey, type CycleParam,
} from './config';

export interface KanbanDealCard {
  id: number;
  title: string;
  amount: number;
  stageName: string;
  stageColor: string | null;
  managerId: string;
  managerName: string;
  createdAt: string;
  url: string;
}

export interface KanbanTaskCard {
  id: number;
  title: string;
  responsibleName: string;
  deadlineAt: string | null;
  createdAt: string | null;
  dealId: number | null;
  dealTitle: string | null;
  url: string;
  dealUrl: string | null;
}

/** Столбик менеджера внутри полосы-колонки (как «user-column» в Битриксе). */
export interface KanbanManagerLane {
  id: string;
  name: string;
  /** Всего карточек менеджера в колонке (cards может быть короче — CARDS_PER_MANAGER). */
  count: number;
  sum: number;
  deals: KanbanDealCard[];
  tasks: KanbanTaskCard[];
}

export interface KanbanColumnData {
  key: ColumnKey;
  total: number;
  /** Сумма сделок колонки (только для kind='deals'). */
  sum: number;
  /** Менеджеры с карточками, по убыванию числа карточек (getSortedUsersForColumn). */
  lanes: KanbanManagerLane[];
}

export interface KanbanManagerOption { id: string; name: string }

export interface KanbanBoard {
  day: string;
  generatedAt: string;
  salesCount: number;
  salesSum: number;
  reservedCount: number;
  reservedSum: number;
  cycle: CycleParam;
  /** Колонки выбранного цикла (в порядке Битрикса); для не считаемых — пустые lanes. */
  columns: KanbanColumnData[];
  /** Менеджеры в зоне ответственности (для фильтра). */
  managers: KanbanManagerOption[];
  /** Выбран фильтр по менеджеру (null — вся зона). */
  managerId: string | null;
  scopeNotice?: string;
}

const NO_SCOPE_NOTICE =
  'Не удалось определить вашу зону ответственности: нет подконтрольных отделов и привязки к Битриксу. '
  + 'Обратитесь к администратору.';

/** Менеджеры зоны (все, включая «заглушки» — как итоги узла в «РОП — сегодня»). */
export async function scopeManagers(scope: RopScope): Promise<KanbanManagerOption[]> {
  const [tree, rowsAll, chains] = await Promise.all([buildTvTree(), loadActiveManagers(), deptChains()]);
  const rows = scopeRows(rowsAll, scope);
  const seen = new Map<string, string>();
  for (const m of managersOfNode(tree.root, rows, chains)) if (!seen.has(m.managerId)) seen.set(m.managerId, m.name);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// Подзапрос «сделки с логистическими задачами в статусах» (getDealIdsWithTasksInStatuses).
// $groups, $statuses, $since — позиции параметров; since = null — без окна по дате.
function dealsWithTasksSql(groupsParam: string, statusesParam: string, sinceParam: string | null): string {
  return `SELECT t.deal_id::int FROM sa.bitrix_task_current t
           WHERE NOT t.is_deleted AND t.deal_id IS NOT NULL
             AND t.group_id = ANY(${groupsParam}::int[]) AND t.status = ANY(${statusesParam}::int[])
             ${sinceParam ? `AND t.changed_at >= ${sinceParam}::timestamptz` : ''}`;
}

interface DealRow {
  deal_id: number; deal_name: string | null; amount: string; stage_name: string | null; stage_color: string | null;
  manager_id: string; created_at: string;
}

function sortLanes(map: Map<string, KanbanManagerLane>): KanbanManagerLane[] {
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

async function dealColumn(
  key: ColumnKey, managerIds: number[], names: Map<string, string>, where: string, params: unknown[],
): Promise<KanbanColumnData> {
  // $1 — менеджеры; остальные параметры колонки начинаются с $2.
  const res = await analyticsDb().query<DealRow>(
    `SELECT d.deal_id, d.deal_name, d.amount, s.name AS stage_name, s.stage_color,
            d.current_manager_id::text AS manager_id, d.created_at
       FROM sa.deals d
       LEFT JOIN sa.stages s ON s.id = d.stage_id
      WHERE d.current_manager_id = ANY($1::int[]) AND (${where})
      ORDER BY d.created_at DESC
      LIMIT ${COLUMN_ROW_LIMIT}`,
    [managerIds, ...params],
  );
  const lanes = new Map<string, KanbanManagerLane>();
  let sum = 0;
  for (const r of res.rows) {
    const amount = Number(r.amount);
    sum += amount;
    let lane = lanes.get(r.manager_id);
    if (!lane) { lane = { id: r.manager_id, name: names.get(r.manager_id) ?? `#${r.manager_id}`, count: 0, sum: 0, deals: [], tasks: [] }; lanes.set(r.manager_id, lane); }
    lane.count++; lane.sum += amount;
    if (lane.deals.length < CARDS_PER_MANAGER) {
      lane.deals.push({
        id: r.deal_id, title: r.deal_name?.trim() || `Сделка ${r.deal_id}`, amount, stageName: r.stage_name ?? '—',
        stageColor: r.stage_color ?? null, managerId: r.manager_id, managerName: lane.name, createdAt: r.created_at, url: dealUrl(r.deal_id),
      });
    }
  }
  return { key, total: res.rows.length, sum, lanes: sortLanes(lanes) };
}

interface TaskRow {
  task_id: string; title: string | null; responsible_id: string; responsible_name: string | null; deadline_at: string | null;
  created_at: string | null; deal_id: string | null; deal_name: string | null; group_id: number | null;
}

async function taskColumn(key: ColumnKey, managerIds: number[], names: Map<string, string>, groupId: number): Promise<KanbanColumnData> {
  const res = await analyticsDb().query<TaskRow>(
    `SELECT t.task_id::text, t.title, t.responsible_id::text, t.responsible_name, t.deadline_at, t.created_at, t.deal_id::text, d.deal_name,
            t.group_id
       FROM sa.bitrix_task_current t
       LEFT JOIN sa.deals d ON d.deal_id = t.deal_id
      WHERE NOT t.is_deleted AND t.group_id = $2 AND t.status = ANY($3::int[])
        AND t.responsible_id = ANY($1::int[])
      ORDER BY t.created_at DESC NULLS LAST
      LIMIT ${COLUMN_ROW_LIMIT}`,
    [managerIds, groupId, [...TASKS_OPEN_OR_CONTROL]],
  );
  const lanes = new Map<string, KanbanManagerLane>();
  for (const r of res.rows) {
    let lane = lanes.get(r.responsible_id);
    if (!lane) { lane = { id: r.responsible_id, name: names.get(r.responsible_id) ?? r.responsible_name ?? `#${r.responsible_id}`, count: 0, sum: 0, deals: [], tasks: [] }; lanes.set(r.responsible_id, lane); }
    lane.count++;
    if (lane.tasks.length < CARDS_PER_MANAGER) {
      lane.tasks.push({
        id: Number(r.task_id), title: r.title?.trim() || `Задача ${r.task_id}`, responsibleName: lane.name, deadlineAt: r.deadline_at,
        createdAt: r.created_at, dealId: r.deal_id ? Number(r.deal_id) : null, dealTitle: r.deal_name ?? null,
        url: taskUrl(r.group_id, Number(r.task_id)), dealUrl: r.deal_id ? dealUrl(Number(r.deal_id)) : null,
      });
    }
  }
  return { key, total: res.rows.length, sum: 0, lanes: sortLanes(lanes) };
}

async function totalsForEvents(managerIds: number[], stages: readonly string[], fromIso: string, toExclIso: string) {
  const res = await analyticsDb().query<{ cnt: number; sum: string }>(
    `SELECT count(*)::int AS cnt, COALESCE(sum(d.amount), 0)::text AS sum
       FROM sa.deals d
      WHERE d.current_manager_id = ANY($1::int[])
        AND d.deal_id IN (SELECT e.deal_id FROM sa.deal_events e
                           WHERE e.stage_id = ANY($2::text[]) AND e.event_at >= $3::timestamptz AND e.event_at < $4::timestamptz)`,
    [managerIds, [...stages], fromIso, toExclIso],
  );
  return { count: res.rows[0]?.cnt ?? 0, sum: Number(res.rows[0]?.sum ?? 0) };
}

export function emptyBoard(day: string, cycle: CycleParam, managers: KanbanManagerOption[], managerId: string | null, notice?: string): KanbanBoard {
  return {
    day, generatedAt: new Date().toISOString(), salesCount: 0, salesSum: 0, reservedCount: 0, reservedSum: 0,
    cycle, columns: columnsForCycle(cycle).map(c => ({ key: c.key, total: 0, sum: 0, lanes: [] })),
    managers, managerId, ...(notice ? { scopeNotice: notice } : {}),
  };
}

function scopeKeyOf(scope: RopScope): string {
  return scope.full ? 'full'
    : scope.selfOnly ? `self:${scope.selfOnly}`
    : `depts:${[...(scope.allowedDeptIds ?? [])].sort().join(',') || 'none'}`;
}

/**
 * Собрать доску. `managerFilter` — id одного менеджера из зоны (иначе игнорируется: чужой id
 * не расширяет выборку, а даёт пустую доску).
 */
export async function buildKanbanBoard(scope: RopScope, managerFilter: string | null, cycle: CycleParam): Promise<KanbanBoard> {
  const day = mskTodayStr();
  return cached(`rop-kanban:v2:${day}:${cycle}:${scopeKeyOf(scope)}:${managerFilter ?? 'all'}`, 30, async () => {
    const managers = await scopeManagers(scope);
    const noOrgBinding = !scope.full && !scope.selfOnly && (!scope.allowedDeptIds || scope.allowedDeptIds.size === 0);
    if (noOrgBinding) return emptyBoard(day, cycle, managers, null, NO_SCOPE_NOTICE);

    const names = new Map(managers.map(m => [m.id, m.name]));
    let ids = managers.map(m => Number(m.id)).filter(n => Number.isInteger(n) && n > 0);
    let appliedFilter: string | null = null;
    if (managerFilter) {
      if (names.has(managerFilter)) { ids = [Number(managerFilter)]; appliedFilter = managerFilter; }
      else ids = []; // менеджер вне зоны — пустая доска, а не чужие данные
    }
    if (ids.length === 0) return emptyBoard(day, cycle, managers, appliedFilter);

    const todayStart = mskMidnightIso(day);
    const tomorrowStart = mskMidnightIso(addDaysStr(day, 1));
    const weekStart = mskMidnightIso(addDaysStr(day, -7));
    const logistSince = new Date(Date.now() - LOGIST_TASK_WINDOW_DAYS * 86_400_000).toISOString();

    const logistG = [...LOGIST_GROUP_IDS];
    const answered = [...TASKS_ANSWERED];
    const waiting = [TASK_STATUS.NEW, TASK_STATUS.PENDING, TASK_STATUS.IN_PROGRESS];
    const better = [...BETTER_PRICE_STAGES];
    const sale = [...SALE_STAGES];
    const lostStagesSql = `SELECT e.deal_id FROM sa.deal_events e JOIN sa.stages ls ON ls.id = e.stage_id
                            WHERE ls.stage_type = 'LOSS' AND e.event_at >= $2::timestamptz`;
    const everSoldSql = `SELECT e2.deal_id FROM sa.deal_events e2 WHERE e2.stage_id = ANY($3::text[])`;

    const D = (key: ColumnKey, where: string, params: unknown[]) => dealColumn(key, ids, names, where, params);
    const T = (key: ColumnKey, groupId: number) => taskColumn(key, ids, names, groupId);

    // Запросы колонок (только SELECT). Считаются лишь колонки выбранного цикла (columnsForCycle);
    // остальные 14 (computed=false) в расчёте не участвуют — в UI стоят пустые, с пометкой.
    const queries: Partial<Record<ColumnKey, () => Promise<KanbanColumnData>>> = {
      unprocessedDeals: () => D('unprocessedDeals', `d.stage_id = ANY($2::text[])`, [[...UNPROCESSED_STAGES]]),
      newDeals: () => D('newDeals', `d.funnel_id = ANY($2::int[]) AND d.created_at >= $3::timestamptz`, [[...PRIMARY_FUNNEL_IDS], todayStart]),
      // «Есть цена дешевле»: стадия + логист уже ответил (задача 4/5 за 14 дней).
      betterPrice: () => D('betterPrice',
        `d.stage_id = ANY($2::text[]) AND d.deal_id IN (${dealsWithTasksSql('$3', '$4', '$5')})`,
        [better, logistG, answered, logistSince]),
      // «Запрос логисту»: стадия запроса + логист ответил. Пересечения с «ценой дешевле» нет (разные стадии).
      logistRequest: () => D('logistRequest',
        `d.stage_id = ANY($2::text[]) AND d.deal_id IN (${dealsWithTasksSql('$3', '$4', '$5')})`,
        [[...LOGIST_REQUEST_STAGES], logistG, answered, logistSince]),
      // «Логист не ответил»: задача открыта (14 дней), стадия запроса или «цена дешевле», но сделка не в колонке «цена дешевле».
      logistNotAnswered: () => D('logistNotAnswered',
        `d.stage_id = ANY($2::text[]) AND d.deal_id IN (${dealsWithTasksSql('$3', '$4', '$5')})
         AND NOT (d.stage_id = ANY($6::text[]) AND d.deal_id IN (${dealsWithTasksSql('$3', '$7', '$5')}))`,
        [[...LOGIST_REQUEST_STAGES, ...BETTER_PRICE_STAGES], logistG, waiting, logistSince, better, answered]),
      // «Ответ логиста не принят»: задача логисту в статусе 4, без окна по дате и по стадии.
      withTasksOnControl: () => D('withTasksOnControl',
        `d.deal_id IN (${dealsWithTasksSql('$2', '$3', null)})`, [logistG, [TASK_STATUS.SUPPOSEDLY_COMPLETED]]),
      withBigDealsTasks: () => D('withBigDealsTasks',
        `d.deal_id IN (${dealsWithTasksSql('$2', '$3', null)})`, [[...BIG_DEALS_GROUP_IDS], [...TASKS_OPEN]]),
      withRepeatingDealsTasks: () => D('withRepeatingDealsTasks',
        `d.deal_id IN (${dealsWithTasksSql('$2', '$3', null)})`, [[...REPEATING_DEALS_GROUP_IDS], [...TASKS_OPEN]]),
      debtTasks: () => T('debtTasks', DEBT_GROUP_ID),
      updTasks: () => T('updTasks', UPD_GROUP_ID),
      callerIssuesTasks: () => T('callerIssuesTasks', CALLER_ISSUES_GROUP_ID),
      // Отказы за сегодня: текущая стадия отказная и lost_at с полуночи МСК (MOVED_TIME в Битриксе).
      failedToday: () => D('failedToday', `s.stage_type = 'LOSS' AND d.lost_at >= $2::timestamptz`, [todayStart]),
      // Отказы из продаж: отказ в окне (история стадий) + сделка когда-либо была на «Продано».
      failedFromSaleToday: () => D('failedFromSaleToday', `d.deal_id IN (${lostStagesSql}) AND d.deal_id IN (${everSoldSql})`, [todayStart, sale]),
      failedFromSaleThisWeek: () => D('failedFromSaleThisWeek', `d.deal_id IN (${lostStagesSql}) AND d.deal_id IN (${everSoldSql})`, [weekStart, sale]),
      allSales: () => D('allSales', `d.stage_id = ANY($2::text[])`, [sale]),
    };

    const visible = columnsForCycle(cycle);
    const [columns, salesT, reservedT] = await Promise.all([
      Promise.all(visible.map(col => {
        const q = col.computed ? queries[col.key] : undefined;
        return q ? q() : Promise.resolve<KanbanColumnData>({ key: col.key, total: 0, sum: 0, lanes: [] });
      })),
      totalsForEvents(ids, SALE_STAGES, todayStart, tomorrowStart),
      totalsForEvents(ids, RESERVED_STAGES, todayStart, tomorrowStart),
    ]);

    return {
      day, generatedAt: new Date().toISOString(), cycle,
      salesCount: salesT.count, salesSum: salesT.sum, reservedCount: reservedT.count, reservedSum: reservedT.sum,
      columns, managers, managerId: appliedFilter,
    } satisfies KanbanBoard;
  });
}
