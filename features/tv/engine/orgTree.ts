// «Телевизоры» — дерево узлов экрана поверх оргструктуры Битрикса (правка владельца
// 08.09): Монолит → филиалы (Москва, Санкт-Петербург, Краснодар) → отделы → команды.
//
// Москва = узел «Московский филиал», Краснодар = «Филиал Краснодар», Монолит = «Отдел
// продаж» (все — реальные uuid). Санкт-Петербург в Битриксе узла не имеет: его отделы
// (Департамент ОС/НЦ/ЮЛ, Отдел стажировки) лежат прямо под «Отделом продаж» — поэтому
// виртуальный узел 'branch:spb'. Два человека, приписанные к голому «Отделу продаж»
// (правило EXACT_ANCHORS в lib/org/deptCategories.ts: это СПб), входят в СПб и Монолит.
//
// Менеджер принадлежит узлу, если uuid узла есть в цепочке предков его отдела
// (`deptUuids` узла = все uuid поддерева). Узлы на экране могут пересекаться.

import { analyticsDb } from '@/lib/db/clients';
import { loadDepartments, type DeptRow } from '@/lib/org/deptCategories';
import type { RosterManager } from '@/lib/org/teamRoster';
import type { TvTreeNode } from '../shared';

export interface TvNode extends TvTreeNode {
  children: TvNode[];
  /** uuid всех отделов поддерева (для uuid-узлов — включая сам узел). */
  deptUuids: Set<string>;
  /** Отделы, чьи ПРЯМЫЕ сотрудники входят в узел без учёта поддерева (голый «Отдел продаж» → СПб). */
  exactUuids: Set<string>;
}

export interface TvTree {
  root: TvNode;
  byId: Map<string, TvNode>;
  /** Подписи узлов для карточек экранов в админке. */
  names: Map<string, string>;
}

const ROOT_NAME = 'Отдел продаж';
const BRANCH_NODES: Record<string, string> = { 'Московский филиал': 'Москва', 'Филиал Краснодар': 'Краснодар' };
export const SPB_ID = 'branch:spb';
const SPB_NAME = 'Санкт-Петербург';
const ROOT_LABEL = 'Монолит';

let _tree: TvTree | null = null;
let _treeAt = 0;

export async function buildTvTree(force = false): Promise<TvTree> {
  if (!force && _tree && Date.now() - _treeAt < 30 * 60 * 1000) return _tree;
  const { byId, byBitrixId } = await loadDepartments();
  const uuidByBitrix = new Map<string, string>();
  const childrenByBitrix = new Map<string, string[]>(); // parent bitrixId → child uuids
  for (const [uuid, row] of byId) {
    uuidByBitrix.set(row.bitrixId, uuid);
    if (row.parentBitrixId) {
      if (!childrenByBitrix.has(row.parentBitrixId)) childrenByBitrix.set(row.parentBitrixId, []);
      childrenByBitrix.get(row.parentBitrixId)!.push(uuid);
    }
  }
  // активность отделов: departments без is_active в кэше — берём все; неактивные
  // отделы без людей просто не дадут карточек (карточки только для узлов с менеджерами)
  let rootUuid: string | null = null;
  for (const [uuid, row] of byId) if (row.name === ROOT_NAME) { rootUuid = uuid; break; }
  const byIdMap = new Map<string, TvNode>();
  const names = new Map<string, string>();

  const mk = (id: string, name: string, kind: TvNode['kind']): TvNode => {
    const n: TvNode = { id, name, kind, children: [], deptUuids: new Set(), exactUuids: new Set() };
    byIdMap.set(id, n); names.set(id, name);
    return n;
  };
  const build = (uuid: string, row: DeptRow, kind: TvNode['kind'], label?: string): TvNode => {
    const n = mk(uuid, label ?? row.name, kind);
    n.deptUuids.add(uuid);
    const kids = (childrenByBitrix.get(row.bitrixId) ?? []).map(u => [u, byId.get(u)!] as const).filter(([, r]) => !!r)
      .sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru'));
    for (const [cu, cr] of kids) {
      const c = build(cu, cr, 'dept');
      n.children.push(c);
      for (const u of c.deptUuids) n.deptUuids.add(u);
    }
    return n;
  };

  let root: TvNode;
  if (!rootUuid) {
    root = mk('root:none', ROOT_LABEL, 'root');
  } else {
    const rootRow = byId.get(rootUuid)!;
    root = mk(rootUuid, ROOT_LABEL, 'root');
    root.deptUuids.add(rootUuid);
    const spb = mk(SPB_ID, SPB_NAME, 'branch');
    spb.exactUuids.add(rootUuid);
    const branches: TvNode[] = [];
    const topKids = (childrenByBitrix.get(rootRow.bitrixId) ?? []).map(u => [u, byId.get(u)!] as const).filter(([, r]) => !!r)
      .sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru'));
    for (const [cu, cr] of topKids) {
      const branchLabel = BRANCH_NODES[cr.name];
      if (branchLabel) {
        const b = build(cu, cr, 'branch', branchLabel);
        branches.push(b);
      } else {
        const d = build(cu, cr, 'dept');
        spb.children.push(d);
        for (const u of d.deptUuids) spb.deptUuids.add(u);
      }
    }
    const ordered = [
      ...branches.filter(b => b.name === 'Москва'),
      spb,
      ...branches.filter(b => b.name === 'Краснодар'),
      ...branches.filter(b => b.name !== 'Москва' && b.name !== 'Краснодар'),
    ];
    for (const b of ordered) { root.children.push(b); for (const u of b.deptUuids) root.deptUuids.add(u); }
  }
  _tree = { root, byId: byIdMap, names }; _treeAt = Date.now();
  return _tree;
}

/** Дерево без служебных полей — для пикера в админке. */
export function toTreeNode(n: TvNode): TvTreeNode {
  return { id: n.id, name: n.name, kind: n.kind, children: n.children.map(toTreeNode) };
}

export interface OrgRow { manager_id: string; manager_name: string; department_id: string | null; short_login: string | null }

export async function loadActiveManagers(): Promise<OrgRow[]> {
  const res = await analyticsDb().query<OrgRow>(
    `SELECT manager_bitrix_user_id::text AS manager_id, manager_name, department_id::text AS department_id, short_login
       FROM sa.org_resolved_hierarchy WHERE is_active = true AND manager_bitrix_user_id IS NOT NULL`,
  );
  return res.rows;
}

/** Цепочки предков (uuid) для отделов — один проход по дереву на вызов. */
export async function deptChains(): Promise<Map<string, Set<string>>> {
  const { byId, byBitrixId } = await loadDepartments();
  const uuidByBitrix = new Map<string, string>();
  for (const [uuid, row] of byId) uuidByBitrix.set(row.bitrixId, uuid);
  const out = new Map<string, Set<string>>();
  for (const [uuid, row] of byId) {
    const set = new Set<string>();
    let cur: DeptRow | undefined = row;
    for (let guard = 0; cur && guard < 15; guard++) {
      const u = uuidByBitrix.get(cur.bitrixId);
      if (u) set.add(u);
      cur = cur.parentBitrixId ? byBitrixId.get(cur.parentBitrixId) : undefined;
    }
    out.set(uuid, set);
  }
  return out;
}

export function managersOfNode(node: TvNode, rows: OrgRow[], chains: Map<string, Set<string>>): RosterManager[] {
  const out: RosterManager[] = [];
  for (const r of rows) {
    if (!r.department_id) continue;
    const chain = chains.get(r.department_id);
    let hit = node.exactUuids.has(r.department_id);
    if (!hit && chain) for (const u of chain) { if (node.deptUuids.has(u)) { hit = true; break; } }
    if (hit) out.push({ managerId: r.manager_id, name: r.manager_name, login: r.short_login, deptUuid: node.id });
  }
  return out;
}

/** Узел nodeId лежит в поддереве одного из узлов rootIds (или совпадает с ним). */
export function nodeWithin(tree: TvTree, rootIds: string[], nodeId: string): boolean {
  const target = tree.byId.get(nodeId);
  if (!target) return false;
  const stack: TvNode[] = rootIds.map(id => tree.byId.get(id)).filter((n): n is TvNode => !!n);
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === nodeId) return true;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    for (const c of n.children) stack.push(c);
  }
  return false;
}
