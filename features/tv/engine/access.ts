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
import { hasPerm } from '@/lib/auth/perms';
import { loadDepartments } from '@/lib/org/deptCategories';
import { getSalesDepartmentOptions } from '@/lib/org/teamRoster';
import { UUID_NODE_RE, type TvScreen } from '../shared';
import { buildTvTree } from './orgTree';

export interface TvScope {
  /** null = без ограничений. */
  allowedDeptIds: Set<string> | null;
  full: boolean;
}

/**
 * Подконтрольные отделы + все их потомки (uuid) — общая часть для tvScope() и
 * ropScope(): у обоих подконтрольные отделы считаются одинаково
 * (managedDepartmentIds + расширение по дереву), расходятся они только в том,
 * ПО КАКОМУ ПРАВУ «полный» доступ (full: true) — это решает каждый вызывающий
 * сам, ДО обращения сюда (см. tvScope/ropScope ниже, задача #6479).
 */
async function expandManagedDepartmentScope(session: SessionUser): Promise<TvScope> {
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

/** Подконтрольные отделы + все их потомки (uuid). */
export async function tvScope(session: SessionUser): Promise<TvScope> {
  if (hasFullManagerAccess(session)) return { allowedDeptIds: null, full: true };
  return expandManagedDepartmentScope(session);
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

/**
 * Скоуп персональной страницы /rop (задача #6446, авторизованная копия /today —
 * решение владельца 14.09: «сделай так, чтобы /today открывался без пароля» плюс
 * «копию как today, но /rop которая с авторизацией и показывает только данные
 * согласно правам»). Подконтрольные отделы считаются ТЕМ ЖЕ способом, что у
 * tvScope()/«Телевизоров» (expandManagedDepartmentScope — КЗ-структура +
 * назначения + «свой филиал» у директора). Рядовой менеджер (МОП) без
 * управляемых отделов — только он сам, по bitrixUserId сессии (в tvScope такого
 * понятия нет — там пусто = «нет доступных экранов», здесь пусто = «свои
 * данные»).
 *
 * «Полный» доступ (full: true, вся компания) — НЕ hasFullManagerAccess()
 * (задача #6479, баг «/rop все аккаунты видят все, а не только своё»):
 * hasFullManagerAccess/роль «Администратор» — это доступ КО ВСЕМ РАЗДЕЛАМ
 * приложения (джокер section.*), не факт того, что человек — руководство
 * компании. На проде эту роль носят, помимо дирекции, ещё маркетолог,
 * разработчик («Отдел развития») и тестовый аккаунт в «Отделе продаж» — все
 * они через hasFullManagerAccess видели всю компанию на /rop. Здесь —
 * ropFullAccess(): отдельное, ПОФАМИЛЬНОЕ право action.rop_today.full_access
 * (lib/auth/perms.ts), джокер section.* его не покрывает; по умолчанию нет ни
 * у одной роли — безопасный дефолт, «руководство» только явно через
 * «Настройки → Роли».
 */
export function ropFullAccess(session: SessionUser): boolean {
  return session.isSuperadmin || hasPerm(session, 'action.rop_today.full_access');
}

export interface RopScope {
  /** true = без ограничений (руководство компании). */
  full: boolean;
  /** null при full; иначе — отделы (и их потомки) в зоне ответственности. */
  allowedDeptIds: Set<string> | null;
  /** bitrix id менеджера, если скоуп сузился до «только я» (нет управляемых отделов). */
  selfOnly: string | null;
}

/**
 * Чистая часть решения — без обращения к БД (принимает уже посчитанный
 * tvScope). Вынесена отдельно, чтобы юнит-тест на «3 роли» (scripts/
 * assert-rop-scope.ts) не тянул за собой Postgres — тот же приём, что у
 * canUnsellDeal/checkUnsellable в lib/sales/unsellDeal.ts.
 */
export function deriveRopScope(base: TvScope, bitrixUserId: string | null): RopScope {
  if (base.full) return { full: true, allowedDeptIds: null, selfOnly: null };
  if (base.allowedDeptIds && base.allowedDeptIds.size > 0) {
    return { full: false, allowedDeptIds: base.allowedDeptIds, selfOnly: null };
  }
  // Нет подконтрольных отделов — не «нет доступа», а «доступ только к себе»:
  // без bitrixUserId (аккаунт не привязан к Битриксу) скоуп остаётся пустым —
  // buildDashboard() отдаст пустое дерево, а не чужие данные.
  return { full: false, allowedDeptIds: new Set(), selfOnly: bitrixUserId };
}

export async function ropScope(session: SessionUser): Promise<RopScope> {
  if (ropFullAccess(session)) return { full: true, allowedDeptIds: null, selfOnly: null };
  const base = await expandManagedDepartmentScope(session);
  return deriveRopScope(base, session.bitrixUserId);
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
