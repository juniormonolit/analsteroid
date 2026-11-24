// Пользователи Битрикса для выбора в «Увольняторе» — ЖИВЫМ user.get (вкл. уже уволенных: ACTIVE обоих
// значений — увольняют часто уже деактивированного). Отделы — по копии оргструктуры public.departments
// (lib/org/sync.ts её ведёт по department.get). Кэш 10 мин.
import { cached } from '@/lib/cache/redis';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadDepartments } from '@/lib/org/deptCategories';
import type { DismissalDepartment, DismissalUser } from '../types';
import { readAll } from './bx';

interface BxUser {
  ID: string; NAME?: string; LAST_NAME?: string; SECOND_NAME?: string; LOGIN?: string; EMAIL?: string;
  WORK_POSITION?: string; UF_DEPARTMENT?: (string | number)[] | string | number | null; ACTIVE?: boolean | string;
  EXTERNAL_AUTH_ID?: string | null; USER_TYPE?: string | null;
}

const isActive = (v: unknown) => v === true || v === 'Y' || v === 'true' || v === 1 || v === '1';

async function departmentNames(): Promise<Map<number, string>> {
  const r = await systemDb().query<{ id: string; name: string }>(
    'SELECT bitrix_department_id::text AS id, name FROM public.departments WHERE bitrix_department_id IS NOT NULL',
  ).catch(() => ({ rows: [] as { id: string; name: string }[] }));
  return new Map(r.rows.map(x => [Number(x.id), x.name]));
}

interface UsersSnapshot {
  users: DismissalUser[];
  /** bitrixId → все отделы пользователя (UF_DEPARTMENT бывает из нескольких) */
  deptIds: Record<number, string[]>;
  deptNames: Record<string, string>;
  /** bitrixId → LOGIN Битрикса (сторож увольнений сопоставляет «М60» → manager60) */
  logins: Record<number, string>;
}

async function loadUsers(): Promise<UsersSnapshot> {
  const select = ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'LOGIN', 'EMAIL', 'WORK_POSITION', 'UF_DEPARTMENT', 'ACTIVE', 'EXTERNAL_AUTH_ID', 'USER_TYPE'];
  // user.get без фильтра ACTIVE на части порталов отдаёт только активных — просим оба значения явно.
  const [on, off] = [
    await readAll<BxUser>('user.get', { FILTER: { ACTIVE: true }, SELECT: select, sort: 'ID', order: 'ASC' }, { pauseMs: 300 }),
    await readAll<BxUser>('user.get', { FILTER: { ACTIVE: false }, SELECT: select, sort: 'ID', order: 'ASC' }, { pauseMs: 300 }),
  ];
  const depts = await departmentNames();
  const seen = new Set<number>();
  const out: DismissalUser[] = [];
  const deptIds: Record<number, string[]> = {};
  const logins: Record<number, string> = {};
  for (const u of [...on, ...off]) {
    const id = Number(u.ID);
    if (!id || seen.has(id)) continue;
    // Боты, открытые линии, IMAP и прочие служебные учётки — не сотрудники.
    if (u.EXTERNAL_AUTH_ID && ['bot', 'imconnector', 'replica', 'email', '__controller', 'shop', 'sale', 'saleanonymous'].includes(u.EXTERNAL_AUTH_ID)) continue;
    seen.add(id);
    if (u.LOGIN?.trim()) logins[id] = u.LOGIN.trim();
    const name = [u.LAST_NAME, u.NAME].map(s => (s ?? '').trim()).filter(Boolean).join(' ') || u.LOGIN || u.EMAIL || `Пользователь #${id}`;
    const all = (Array.isArray(u.UF_DEPARTMENT) ? u.UF_DEPARTMENT : u.UF_DEPARTMENT != null ? [u.UF_DEPARTMENT] : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0).map(String);
    deptIds[id] = [...new Set(all)];
    const first = all[0] ?? null;
    out.push({
      bitrixId: id, name, position: u.WORK_POSITION?.trim() || null,
      department: first ? depts.get(Number(first)) ?? null : null, departmentId: first, active: isActive(u.ACTIVE),
      dismissable: false, // по срезу инициатора проставляет роут (scope.ts)
    });
  }
  // Активные сверху, внутри — по имени.
  out.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'ru'));
  return { users: out, deptIds, logins, deptNames: Object.fromEntries([...depts].map(([k, v]) => [String(k), v])) };
}

const snapshot = () => cached('dismissal:users:v3', 600, loadUsers);

export async function listDismissalUsers(): Promise<DismissalUser[]> {
  return withOrgDepartments();
}

/**
 * «Активный менеджер» — критерий проекта: строка sa.org_resolved_hierarchy с is_active = true (его же берут
 * teamRoster, карточки отдела, отчёты), И не уволен в Битрихе прямо сейчас (живой user.get ACTIVE).
 * Отдел — department_id той же строки, id отдела наружу — Битрикс-id (sa.departments.bitrix_department_id),
 * тот же, что DismissalUser.departmentId. Отдел без активных менеджеров не показываем.
 */
async function activeManagersByDept(): Promise<{ byDept: Map<string, number[]>; deptOf: Map<number, string>; names: Map<string, string> }> {
  const [s, rows, { byId }] = await Promise.all([
    snapshot(),
    analyticsDb().query<{ id: string; dept: string | null }>(
      `SELECT manager_bitrix_user_id::text AS id, department_id::text AS dept FROM sa.org_resolved_hierarchy WHERE is_active = true`,
    ),
    loadDepartments(),
  ]);
  const liveActive = new Set(s.users.filter(u => u.active).map(u => u.bitrixId));
  const byDept = new Map<string, number[]>();
  const deptOf = new Map<number, string>();
  const names = new Map<string, string>();
  for (const r of rows.rows) {
    const id = Number(r.id);
    const d = r.dept ? byId.get(r.dept) : undefined;
    if (!id || !d) continue;
    deptOf.set(id, d.bitrixId);
    names.set(d.bitrixId, d.name);
    if (!liveActive.has(id)) continue;
    const list = byDept.get(d.bitrixId) ?? [];
    if (!list.includes(id)) list.push(id);
    byDept.set(d.bitrixId, list);
  }
  return { byDept, deptOf, names };
}

/** Отделы, где есть активные менеджеры. По имени; менеджеры — по имени. */
export async function listDismissalDepartments(): Promise<DismissalDepartment[]> {
  const [{ byDept, names }, users] = await Promise.all([activeManagersByDept(), withOrgDepartments()]);
  const byId = new Map(users.map(u => [u.bitrixId, u]));
  return [...byDept].map(([id, ids]) => ({
    id, name: names.get(id) ?? `Отдел #${id}`,
    managers: ids.map(x => byId.get(x)).filter((u): u is DismissalUser => !!u).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  })).filter(d => d.managers.length).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Получатели «раскидать по отделу» на момент start: активные менеджеры отдела без увольняемого, по bitrixId (стабильно). */
export async function departmentTargets(departmentId: string, excludeId: number): Promise<number[]> {
  const { byDept } = await activeManagersByDept();
  return (byDept.get(departmentId) ?? []).filter(id => id !== excludeId).sort((a, b) => a - b);
}

export async function departmentName(departmentId: string): Promise<string> {
  const { names } = await activeManagersByDept();
  return names.get(departmentId) ?? `Отдел #${departmentId}`;
}

/** Пользователи с отделом по оргструктуре проекта (менеджеры — отдел из org_resolved_hierarchy, даже если
 *  уже уволены: UI предложит «его отдел»); прочие — первый UF_DEPARTMENT. */
async function withOrgDepartments(): Promise<DismissalUser[]> {
  const [s, org] = await Promise.all([snapshot(), activeManagersByDept().catch(() => null)]);
  if (!org) return s.users;
  return s.users.map(u => {
    const d = org.deptOf.get(u.bitrixId);
    return d ? { ...u, departmentId: d, department: org.names.get(d) ?? u.department } : u;
  });
}

/** bitrixId → имя (для userNames деталей прогона). Не нашёлся — «#id». */
export async function userNameMap(ids: Iterable<number>): Promise<Record<number, string>> {
  const want = [...new Set([...ids].filter(n => Number.isFinite(n) && n > 0))];
  if (!want.length) return {};
  const users = await listDismissalUsers().catch(() => [] as DismissalUser[]);
  const byId = new Map(users.map(u => [u.bitrixId, u.name]));
  return Object.fromEntries(want.map(id => [id, byId.get(id) ?? `#${id}`]));
}

export async function findDismissalUser(bitrixId: number): Promise<DismissalUser | null> {
  const users = await listDismissalUsers();
  return users.find(u => u.bitrixId === bitrixId) ?? null;
}

/** Справочник для сторожа увольнений: все пользователи Битрикса (вкл. уволенных) с LOGIN. */
export async function userDirectory(): Promise<{ bitrixId: number; name: string; login: string | null; active: boolean }[]> {
  const s = await snapshot();
  return s.users.map(u => ({ bitrixId: u.bitrixId, name: u.name, login: s.logins?.[u.bitrixId] ?? null, active: u.active }));
}
