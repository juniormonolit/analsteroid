/**
 * Запросы к снимку — то, что делают эндпоинты app.py: /api/report, /api/tasks, /api/goods, /api/dom, /api/dom/deals.
 * Права по регионам и разбор query-параметров — на стороне API (см. app.py `_args`).
 */
import { aggregate, domDealsList, domTree, goodsTasks, goodsTree, listTasks, PICK } from './metrics';
import type { Aggregate, Dt, DomDealRow, DomTree, Filter, GoodsTree, TaskListRow } from './metrics';
import { STATUS } from './snapshot';
import type { Snapshot } from './snapshot';

export const LIST_LIMIT = 5000;

export const report = (s: Snapshot, d0: Dt, d1: Dt, f: Filter = {}): Aggregate => aggregate(s.facts, d0, d1, f);
export const goods = (s: Snapshot, d0: Dt, d1: Dt, f: Filter = {}): GoodsTree => goodsTree(s.facts, d0, d1, f);
export const dom = (s: Snapshot, d0: Dt, d1: Dt, f: Filter = {}): DomTree => domTree(s.deals, d0, d1, f.region ?? null);

export interface TaskListOut extends Omit<TaskListRow, 'manager_who' | 'manager_id'> {
  title: string | null; stage: string | null; manager: string | null; category: string | null;
  amount: number | null; task_url: string; deal_url: string | null;
}

/** /api/tasks: path — узел дерева товаров «s105/s361/p5704» (только запросы с позицией из узла). */
export function tasks(s: Snapshot, d0: Dt, d1: Dt, metric: string, f: Filter = {}, path = ''): { metric: string; total: number; shown: number; rows: TaskListOut[] } {
  if (!Object.prototype.hasOwnProperty.call(PICK, metric)) throw new Error(`неизвестный показатель ${metric}`);
  let rows = listTasks(s.facts, d0, d1, metric, f);
  if (path) {
    const ids = goodsTasks(s.facts, path.split('/'));
    rows = rows.filter(r => ids.has(r.id));
  }
  const total = rows.length;
  rows = rows.slice(0, LIST_LIMIT);
  const { tasks: info, stages, amounts, portal } = s.taskInfo;
  const P = `https://${portal}`;
  const users = s.facts.users, projects = s.facts.projects;
  const name = (u: number | null): string | null => (u ? users[String(u)] || `id ${u}` : null);
  const out = rows.map(r => {
    const [title, status, stage, creator] = info[String(r.id)] ?? [null, null, null, null];
    const { manager_who, manager_id: _mid, ...rest } = r;
    void _mid;
    return {
      ...rest,
      title,
      stage: (stage !== null ? stages[String(stage)] : null) || (status !== null ? STATUS[status] : undefined) || (status ? `статус ${status}` : null),
      manager: manager_who || name(creator),
      category: projects[String(r.g)]?.name ?? null,
      amount: r.deal ? (amounts[String(r.deal)] ?? null) : null,
      task_url: `${P}/workgroups/group/${r.g}/tasks/task/view/${r.id}/`,
      deal_url: r.deal ? `${P}/crm/deal/details/${r.deal}/` : null,
    } satisfies TaskListOut;
  });
  return { metric, total, shown: out.length, rows: out };
}

export type DomDealOut = DomDealRow & { deal_url: string; task_urls: string[] };

/** /api/dom/deals */
export function domDeals(s: Snapshot, d0: Dt, d1: Dt, node: string, kind: 'dom' | 'has', f: Filter = {}): { total: number; shown: number; rows: DomDealOut[] } {
  const all = domDealsList(s.deals, d0, d1, node, kind, f.region ?? null);
  const P = `https://${s.taskInfo.portal}`;
  const rows = all.slice(0, LIST_LIMIT).map(r => ({
    ...r,
    deal_url: `${P}/crm/deal/details/${r.deal}/`,
    task_urls: r.tasks.map(t => `${P}/company/personal/user/0/tasks/task/view/${t}/`),
  }));
  return { total: all.length, shown: rows.length, rows };
}
