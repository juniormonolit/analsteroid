// Общее оргдерево аналитики канбана повторных (26.10, проект Fable: «одна иерархическая таблица на каждом табе»).
// Метрики менеджера — один плоский агрегат MAgg из трёх источников (снимок, журнал, результат задач, скорость);
// вверх по дереву — сумма (массивы для медиан — склейка). Первым уровнем — подразделения «Отдела продаж»,
// остальное — «Прочие подразделения»; одиночный корень («Дирекция») разворачивается.
import type { OrgNode } from '../engine/saLookups';

export interface MAgg {
  managers: number;
  // Снимок (последний): состояние пула.
  total: number; pool: number; poolHot: number; poolPotential: number; workedByTask: number;
  inWork: number; funnel: number; funnelSum: number; review: number; hidden: number; brak: number; noTask: number;
  // Журнал (период): действия людей.
  actions: number; leak: number; reviews: number; returned: number; acceptedKanban: number;
  // Результат задач (период, когортно от постановки).
  tasks: number; clientsTaken: number; base: number; reached: number; soldN: number; soldSum: number; shippedN: number; shippedSum: number;
  mature: number; matureSold: number; matureShipped: number; inProgress: number; shipDays: number[];
  // Скорость (остатки — сейчас, потоки — период).
  control: number; controlWaitH: number[]; overdue: number; overdue7: number; openTasks: number; closed: number; reviewH: number[]; queued: number;
  // ИИ-разборы (период): по основному менеджеру разбора.
  aiAnalyses: number; aiScoreSum: number; aiScoreN: number; aiViolations: number; aiRequests: number;
  // Задачи по статусу сейчас (вкладка «Задачи»).
  notStarted: number; inProgressT: number; deferred: number;
}

export const ZERO = (): MAgg => ({
  managers: 0, total: 0, pool: 0, poolHot: 0, poolPotential: 0, workedByTask: 0, inWork: 0, funnel: 0, funnelSum: 0, review: 0, hidden: 0, brak: 0, noTask: 0,
  actions: 0, leak: 0, reviews: 0, returned: 0, acceptedKanban: 0,
  tasks: 0, clientsTaken: 0, base: 0, reached: 0, soldN: 0, soldSum: 0, shippedN: 0, shippedSum: 0, mature: 0, matureSold: 0, matureShipped: 0, inProgress: 0, shipDays: [],
  control: 0, controlWaitH: [], overdue: 0, overdue7: 0, openTasks: 0, closed: 0, reviewH: [], queued: 0,
  aiAnalyses: 0, aiScoreSum: 0, aiScoreN: 0, aiViolations: 0, aiRequests: 0,
  notStarted: 0, inProgressT: 0, deferred: 0,
});

export function mergeAgg(list: MAgg[]): MAgg {
  const o = ZERO();
  for (const a of list) {
    for (const k of Object.keys(o) as (keyof MAgg)[]) {
      const v = a[k];
      if (Array.isArray(v)) (o[k] as number[]).push(...v);
      else (o[k] as number) += v as number;
    }
  }
  return o;
}

export const pct = (a: number, b: number): number | null => (b ? Math.round((a / b) * 1000) / 10 : null);
export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
/** Проработано (как кольцо доски): с задачей РОПа среди «с задачей + окно открыто без сделки». */
export const worked = (a: MAgg) => pct(a.workedByTask, a.workedByTask + a.poolHot);
/** Активность: действий на 100 заказчиков в пуле (без эффекта размера отдела). */
export const per100 = (a: MAgg) => (a.pool ? Math.round((a.actions / a.pool) * 1000) / 10 : null);
/** CR Взят → Продажа: продано среди поставленных (не перепоставленных); часть задач ещё в работе. */
export const crSold = (a: MAgg) => pct(a.soldN, a.base);
export const crShipped = (a: MAgg) => pct(a.shippedN, a.base);

export interface TreeNode { id: string; name: string; depth: number; kind: 'org' | 'mgr'; agg: MAgg; children: TreeNode[] }

export function buildTree(org: OrgNode[], mgrs: { managerId: string; name: string; deptId: string | null; agg: MAgg }[]): { roots: TreeNode[]; total: TreeNode } {
  const byId = new Map(org.map(o => [o.id, o]));
  const childrenOf = new Map<string | null, OrgNode[]>();
  for (const o of org) { const p = o.parentId && byId.has(o.parentId) ? o.parentId : null; const l = childrenOf.get(p) ?? []; l.push(o); childrenOf.set(p, l); }
  const mgrByDept = new Map<string, typeof mgrs>();
  for (const m of mgrs) { const k = m.deptId && byId.has(m.deptId) ? m.deptId : '__none'; const l = mgrByDept.get(k) ?? []; l.push(m); mgrByDept.set(k, l); }
  const leaf = (m: (typeof mgrs)[number], depth: number): TreeNode => ({ id: `m:${m.managerId}`, name: m.name, depth, kind: 'mgr', agg: { ...m.agg, managers: 1 }, children: [] });
  const mk = (o: OrgNode, depth: number): TreeNode | null => {
    const kids = (childrenOf.get(o.id) ?? []).map(c => mk(c, depth + 1)).filter((x): x is TreeNode => !!x);
    const all = [...kids, ...(mgrByDept.get(o.id) ?? []).map(m => leaf(m, depth + 1))];
    if (!all.length) return null;
    return { id: o.id, name: o.name, depth, kind: 'org', agg: mergeAgg(all.map(c => c.agg)), children: all };
  };
  let top = (childrenOf.get(null) ?? []).map(o => mk(o, 0)).filter((x): x is TreeNode => !!x);
  while (top.length === 1 && top[0].children.some(c => c.kind === 'org')) top = top[0].children;
  const sales = top.find(n => n.kind === 'org' && /^отдел продаж$/i.test(n.name.trim()));
  if (sales) {
    const rest = top.filter(n => n !== sales);
    top = [...sales.children];
    if (rest.length) top.push({ id: '__other', name: 'Прочие подразделения', depth: 0, kind: 'org', agg: mergeAgg(rest.map(c => c.agg)), children: rest });
  }
  const none = mgrByDept.get('__none');
  if (none?.length) {
    const kids = none.map(m => leaf(m, 1));
    top.push({ id: '__none', name: 'Без отдела', depth: 0, kind: 'org', agg: mergeAgg(kids.map(k => k.agg)), children: kids });
  }
  const redepth = (n: TreeNode, d: number) => { n.depth = d; n.children.forEach(c => redepth(c, d + 1)); };
  top.forEach(r => redepth(r, 0));
  return { roots: top, total: { id: '__total', name: 'Итого', depth: 0, kind: 'org', agg: mergeAgg(top.map(r => r.agg)), children: [] } };
}

/** Узлы уровня (0 — филиалы/департаменты верхнего уровня, 1 — их дети, …), только оргузлы. */
export function nodesAtLevel(roots: TreeNode[], level: number): { node: TreeNode; path: string }[] {
  const out: { node: TreeNode; path: string }[] = [];
  const walk = (n: TreeNode, path: string[]) => {
    if (n.kind !== 'org' || n.id === '__other' || n.id === '__none') return;
    if (n.depth === level) { out.push({ node: n, path: [...path, n.name].join(' · ') }); return; }
    n.children.forEach(c => walk(c, [...path, n.name]));
  };
  roots.forEach(r => walk(r, []));
  return out;
}
