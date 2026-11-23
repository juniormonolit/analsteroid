// Задачник: кого можно указать постановщиком задачи (правка директора по продажам 23.11:
// «в задаче надо чтоб можно было выбирать постановщика»).
//
// Правило (решение сессии C, по коду scope):
// - сам пользователь — всегда (если аккаунт связан с Битриксом);
// - директор по продажам выбранных менеджеров (tasker_settings.directors по филиалу) — всем,
//   кто ставит задачи: РОП может поставить «от директора»; без выбранных менеджеров — директор
//   филиала самого пользователя;
// - РОПы — только «широким» постановщикам (админ / роль «Директор» / директор из настроек, тот же
//   признак, что обход лимита canOverrideLimits): РОПы выбранных менеджеров + все РОПы их среза
//   (scope 'all' — все РОПы компании, 'depts' — РОПы менеджеров его отделов) + все директора из
//   настроек. Обычный РОП других РОПов не выбирает — «только себя или своего директора».
// Сервер проверяет выбор тем же списком (createTasks), клиент лишь показывает его.
import { analyticsDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { canSeeManager, type SessionScope } from '@/lib/org/sessionScope';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import type { TaskerCreatorOption, TaskerCreatorsResponse } from '../types';
import { directorFor, type TaskerSettings } from './config';
import { canOverrideLimits } from './create';

export async function creatorOptions(
  session: SessionUser, scope: SessionScope, settings: TaskerSettings, managerIds: string[],
): Promise<TaskerCreatorsResponse> {
  const dir = await getEmployeeDirectory();
  const selfId = session.bitrixUserId ? Number(session.bitrixUserId) : null;
  const broad = canOverrideLimits(session, settings);
  const managers = managerIds.filter(id => canSeeManager(scope, id));

  const out = new Map<number, TaskerCreatorOption>();
  const add = (idRaw: string | number | null | undefined, role: TaskerCreatorOption['role'], hint: string | null) => {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0 || out.has(id)) return;
    const e = dir.get(id);
    out.set(id, { id, name: e?.name ?? `#${id}`, role, hint: hint ?? e?.departmentName ?? null });
  };

  if (selfId) add(selfId, 'self', 'Вы');

  // Директора выбранных менеджеров (или своего филиала).
  const branches = managers.length
    ? managers.map(id => dir.get(Number(id))?.branch ?? null)
    : [selfId ? dir.get(selfId)?.branch ?? null : null];
  for (const b of branches) add(directorFor(settings, b), 'director', 'Директор по продажам');

  if (broad) {
    for (const d of Object.values(settings.directors)) add(d, 'director', 'Директор по продажам');
    const db = analyticsDb();
    const rops = await db.query<{ rop: string }>(
      scope.kind === 'all'
        ? `SELECT DISTINCT rop_bitrix_user_id AS rop FROM sa.org_resolved_hierarchy
             WHERE is_active AND rop_bitrix_user_id IS NOT NULL`
        : `SELECT DISTINCT rop_bitrix_user_id AS rop FROM sa.org_resolved_hierarchy
             WHERE rop_bitrix_user_id IS NOT NULL
               AND (manager_bitrix_user_id = ANY($1::text[]) OR (is_active AND manager_bitrix_user_id = ANY($2::text[])))`,
      scope.kind === 'all' ? [] : [managers, scope.kind === 'depts' ? [...scope.managerIds] : []],
    );
    const ropIds = rops.rows.map(r => r.rop).filter(id => dir.get(Number(id))?.isActive !== false);
    const named = ropIds
      .map(id => ({ id, name: dir.get(Number(id))?.name ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    for (const r of named) add(r.id, 'rop', null);
  }

  const order = { self: 0, director: 1, rop: 2 } as const;
  const creators = [...out.values()].sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name, 'ru'));
  return { creators, selfId };
}
