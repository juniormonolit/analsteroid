// «Телевизоры» — кто какие экраны видит и правит.
//
// Вход в раздел — право section.tv (закрытый раздел по паттерну section.offload:
// по умолчанию только супер-админ, роли — явно). Внутри раздела:
//   • руководство (hasFullManagerAccess: супер-админ, «Администратор», «Директор»)
//     — все экраны и рассылка «на все»;
//   • остальные (РОП с правом) — только экраны, ВСЕ отделы которых входят в его
//     подконтрольные (managedDepartmentIds + потомки по дереву), и сообщения
//     только адресно на эти экраны. Формулировка владельца 07.09: «админы,
//     директора и ропы могут на все телевизоры или только на подконтрольные
//     отделы по логике иерархии».

import type { SessionUser } from '@/lib/auth/session';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { loadDepartments } from '@/lib/org/deptCategories';
import { getSalesDepartmentOptions } from '@/lib/org/teamRoster';
import { UUID_NODE_RE, type TvScreen } from '../shared';
import { buildTvTree } from './orgTree';

export interface TvScope {
  /** null = без ограничений. */
  allowedDeptIds: Set<string> | null;
  full: boolean;
}

/** Подконтрольные отделы + все их потомки (uuid). */
export async function tvScope(session: SessionUser): Promise<TvScope> {
  if (hasFullManagerAccess(session)) return { allowedDeptIds: null, full: true };
  const managed = await managedDepartmentIds(session);
  if (managed.length === 0) return { allowedDeptIds: new Set(), full: false };
  const { byId, byBitrixId } = await loadDepartments();
  // потомки: обходим всё дерево и берём узлы, у которых в цепочке предков есть управляемый
  const managedBitrix = new Set(managed.map(id => byId.get(id)?.bitrixId).filter((v): v is string => !!v));
  const allowed = new Set<string>(managed);
  for (const [uuid, row] of byId) {
    let cur = row;
    for (let guard = 0; cur && guard < 15; guard++) {
      if (managedBitrix.has(cur.bitrixId)) { allowed.add(uuid); break; }
      if (!cur.parentBitrixId) break;
      const parent = byBitrixId.get(cur.parentBitrixId);
      if (!parent) break;
      cur = parent;
    }
  }
  return { allowedDeptIds: allowed, full: false };
}

export function screenInScope(scope: TvScope, deptIds: string[]): boolean {
  if (!scope.allowedDeptIds) return true;
  if (deptIds.length === 0) return false;
  // виртуальные узлы (branch:spb) — только у руководства с полным доступом
  return deptIds.every(id => UUID_NODE_RE.test(id) && scope.allowedDeptIds!.has(id));
}

export function filterScreens(scope: TvScope, screens: TvScreen[]): TvScreen[] {
  return scope.allowedDeptIds ? screens.filter(s => screenInScope(scope, s.departmentIds)) : screens;
}

/** id отдела → имя, для подписей экранов (поддерево «Отдел продаж» + фолбэк на всё дерево). */
export async function departmentNameMap(): Promise<Map<string, string>> {
  const [sales, all, tree] = await Promise.all([getSalesDepartmentOptions(), loadDepartments(), buildTvTree()]);
  const map = new Map<string, string>();
  for (const [uuid, row] of all.byId) map.set(uuid, row.name);
  for (const d of sales) map.set(d.id, d.name);
  // подписи дерева экранов поверх: «Отдел продаж» → «Монолит», «Московский филиал» → «Москва», branch:spb
  for (const [id, name] of tree.names) map.set(id, name);
  return map;
}
