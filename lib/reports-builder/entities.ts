// Сущности конструктора отчётов: «личный», отдел, филиал → набор менеджеров.
//
// Гейт доступа — тот же, что у карточек (lib/org/managerAccess): менеджер видит
// только себя, РОП — свои отделы, руководство — всё. Второй системы понятий не
// заводим: если человек не может открыть карточку отдела, он не должен получать
// его цифры и через конструктор.

import type { SessionUser } from '@/lib/auth/session';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import {
  getSalesDepartmentOptions,
  resolveManagersForDepartments,
  type DeptOption,
} from '@/lib/org/teamRoster';
import { analyticsDb } from '@/lib/db/clients';
import { branchLabel } from '@/lib/org/branchLabel';

export type EntityInput =
  | { kind: 'self' }
  | { kind: 'department'; id: string }
  | { kind: 'branch'; id: string };

export interface ResolvedEntity {
  /** Ключ для движка: 'self' | 'dept:<uuid>' | 'branch:<key>'. */
  key: string;
  /** Подпись в разбивке. */
  title: string;
  /** Короткое имя для заголовка агрегата: «ИТОГО (ОС+НЦ)». */
  shortTitle: string;
  /** bitrix id менеджеров сущности. */
  managerIds: Set<string>;
}

export class EntityAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityAccessError';
  }
}

async function branchManagers(): Promise<Map<string, { title: string; ids: Set<string> }>> {
  const res = await analyticsDb().query<{ branch: string | null; manager_id: string }>(
    `SELECT branch, manager_bitrix_user_id::text AS manager_id
       FROM sa.org_resolved_hierarchy
      WHERE is_active = true AND manager_bitrix_user_id IS NOT NULL`,
  );
  const out = new Map<string, { title: string; ids: Set<string> }>();
  for (const row of res.rows) {
    // Правило проекта: не Москва и не Краснодар → СПб (см. grouping.ts).
    const key = row.branch ?? 'СПб';
    if (!out.has(key)) out.set(key, { title: branchLabel(key), ids: new Set() });
    out.get(key)!.ids.add(row.manager_id);
  }
  return out;
}

/** Что человеку вообще доступно выбрать — этим же списком питается пикер в UI. */
export async function availableEntities(session: SessionUser): Promise<{
  self: { managerId: string; name: string } | null;
  departments: DeptOption[];
  branches: { id: string; name: string }[];
}> {
  const full = hasFullManagerAccess(session);
  // Список отделов — ПОДДЕРЕВО «Отдела продаж» целиком (28 отделов вместо
  // прежних 16 «с назначенным руководителем»): правка владельца 07.08 — «должно
  // быть можно выбрать любую команду по структуре… „Отдел металлопроката“
  // отсутствует» + «пикер должен быть ограничен „Отделом продаж“, маркетинг и
  // дирекция нас в продажах не интересуют». Права не меняются: руководству —
  // все продажи, РОПу — только его отделы.
  const [departments, branches] = await Promise.all([
    full ? getSalesDepartmentOptions() : managedDepartmentIds(session).then(async ids => {
      if (ids.length === 0) return [] as DeptOption[];
      const all = await getSalesDepartmentOptions();
      const allowed = new Set(ids);
      return all.filter(d => allowed.has(d.id));
    }),
    full ? branchManagers().then(m => [...m].map(([id, v]) => ({ id, name: v.title }))) : Promise.resolve([]),
  ]);
  return {
    self: session.bitrixUserId ? { managerId: session.bitrixUserId, name: session.displayName ?? 'Я' } : null,
    departments,
    branches,
  };
}

/**
 * Разворачивает выбранные сущности в наборы менеджеров, проверяя права.
 * Бросает EntityAccessError — вызывающий отдаёт 403, а не молча пустой отчёт:
 * пустой отчёт человек примет за «продаж нет», а это опаснее отказа.
 */
export async function resolveEntities(
  session: SessionUser,
  entities: EntityInput[],
): Promise<ResolvedEntity[]> {
  const full = hasFullManagerAccess(session);
  const allowedDepts = full ? null : new Set(await managedDepartmentIds(session));
  // Имена — из той же полной структуры, что и пикер: иначе у отдела, которого нет
  // в user_departments, подпись схлопывалась бы в фолбэк «Отдел».
  const deptOptions = new Map((await getSalesDepartmentOptions()).map(d => [d.id, d.name]));
  const branches = entities.some(e => e.kind === 'branch') ? await branchManagers() : null;

  const out: ResolvedEntity[] = [];
  for (const e of entities) {
    if (e.kind === 'self') {
      if (!session.bitrixUserId) throw new EntityAccessError('У аккаунта нет привязки к Битриксу — личный отчёт не собрать');
      out.push({
        key: 'self',
        title: session.displayName ?? 'Я',
        shortTitle: session.displayName ?? 'Я',
        managerIds: new Set([session.bitrixUserId]),
      });
      continue;
    }

    if (e.kind === 'department') {
      if (allowedDepts && !allowedDepts.has(e.id)) {
        throw new EntityAccessError('Нет доступа к данным этого отдела');
      }
      const roster = await resolveManagersForDepartments([e.id]);
      const name = deptOptions.get(e.id) ?? 'Отдел';
      out.push({
        key: `dept:${e.id}`,
        title: name,
        shortTitle: name,
        managerIds: new Set(roster.map(m => m.managerId)),
      });
      continue;
    }

    if (!full) throw new EntityAccessError('Филиал целиком доступен только руководству');
    const branch = branches?.get(e.id);
    if (!branch) throw new EntityAccessError(`Неизвестный филиал: ${e.id}`);
    out.push({
      key: `branch:${e.id}`,
      title: branch.title,
      shortTitle: e.id,
      managerIds: new Set(branch.ids),
    });
  }
  return out;
}
