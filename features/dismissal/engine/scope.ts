// Доступ «Увольнятора» по иерархии (v3, владелец 24.11: «запускать можно только на подчинённых, каждый видит
// только по иерархии»). Срез — общий механизм проекта (lib/org/sessionScope.ts):
//   Администратор / суперадмин — срез 'all': видит всех, увольнять может всех, КРОМЕ администраторов и
//     суперадминов (users Монолитики: роль «Администратор» или is_superadmin, связь по users.bitrix_user_id);
//   Директор — свой филиал и ниже (canSeeManager); администраторов не увольняет и он.
// Себя — никогда (ни увольнять, ни видеть прогон по себе). Получатели в плане — в пределах среза; РОП
// уволенного, определённый сканированием (dismissal_runs.rop_bitrix_id), допустим всегда.
import type { SessionUser } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadDepartments } from '@/lib/org/deptCategories';
import { canSeeManager, getSessionScope, type SessionScope } from '@/lib/org/sessionScope';
import type { DismissalPlan } from '../types';

export interface DismissalScope {
  scope: SessionScope;
  selfId: number | null;
  /** Битрикс-id администраторов и суперадминов Монолитики — их не увольняет никто. */
  protectedIds: Set<number>;
  /** Уже НЕактивные (уволенные в Битриксе) сотрудники отделов среза: срез проекта строится по активным,
   *  а увольняют часто уже деактивированного — без этого РОП не открыл бы черновик из сообщения бота. */
  inactiveInScope: Set<number>;
}

async function inactiveOfDepts(scope: SessionScope): Promise<Set<number>> {
  if (scope.kind !== 'depts' || !scope.deptIds.size) return new Set();
  const r = await analyticsDb().query<{ id: string }>(
    `SELECT manager_bitrix_user_id::text AS id FROM sa.org_resolved_hierarchy
      WHERE is_active IS NOT TRUE AND department_id::text = ANY($1::text[])`, [[...scope.deptIds]],
  );
  return new Set(r.rows.map(x => Number(x.id)).filter(n => n > 0));
}

export async function protectedBitrixIds(): Promise<Set<number>> {
  const r = await systemDb().query<{ id: string }>(
    `SELECT DISTINCT u.bitrix_user_id::text AS id
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE (u.is_superadmin OR r.name = 'Администратор') AND u.bitrix_user_id IS NOT NULL`,
  );
  return new Set(r.rows.map(x => Number(x.id)).filter(n => Number.isInteger(n) && n > 0));
}

export async function dismissalScope(session: SessionUser): Promise<DismissalScope> {
  const [scope, protectedIds] = await Promise.all([getSessionScope(session), protectedBitrixIds()]);
  const inactiveInScope = await inactiveOfDepts(scope);
  return { scope, selfId: Number(session.bitrixUserId) || null, protectedIds, inactiveInScope };
}

/** Сотрудник в срезе инициатора (для списков, получателей, прогонов). */
export function inScope(s: DismissalScope, bitrixId: number): boolean {
  return canSeeManager(s.scope, String(bitrixId)) || s.inactiveInScope.has(bitrixId);
}

/** Можно ли запустить Увольнятор на этого сотрудника. */
export function canDismiss(s: DismissalScope, bitrixId: number): boolean {
  if (!bitrixId || bitrixId === s.selfId) return false;
  if (s.protectedIds.has(bitrixId)) return false;
  return inScope(s, bitrixId);
}

/** Прогон виден (GET/PATCH/команды/список), если увольняемый в срезе и это не сам инициатор. */
export function canSeeRun(s: DismissalScope, sourceBitrixId: number): boolean {
  return sourceBitrixId !== s.selfId && inScope(s, sourceBitrixId);
}

/** Битрикс-id отделов среза; null — без ограничения (админ). */
export async function scopeDeptBitrixIds(s: DismissalScope): Promise<Set<string> | null> {
  if (s.scope.kind === 'all') return null;
  if (s.scope.kind === 'self') return new Set();
  const { byId } = await loadDepartments();
  return new Set([...s.scope.deptIds].map(u => byId.get(u)?.bitrixId).filter((b): b is string => !!b).map(String));
}

/**
 * Получатели плана вне среза инициатора → текст ошибки (null — всё в порядке).
 * Проверяются targets правил, target исключений, выбранный РОП и отдел «раскидать по отделу».
 * runRop — РОП, определённый сканированием: он допустим всегда.
 */
export async function planScopeError(s: DismissalScope, plan: DismissalPlan, runRop: number | null, name: (id: number) => string): Promise<string | null> {
  if (s.scope.kind === 'all') return null;
  const ok = (id: number) => id === runRop || inScope(s, id);
  const foreign = new Set<number>();
  for (const rule of Object.values(plan.rules)) for (const t of rule?.departmentId ? [] : rule?.targets ?? []) if (!ok(t)) foreign.add(t);
  for (const o of Object.values(plan.overrides)) if (o?.target && !ok(o.target)) foreign.add(o.target);
  if (plan.ropBitrixId && !ok(plan.ropBitrixId)) foreign.add(plan.ropBitrixId);
  const depts = await scopeDeptBitrixIds(s);
  const badDepts = [...new Set(Object.values(plan.rules).map(r => r?.departmentId).filter((d): d is string => !!d))].filter(d => depts && !depts.has(d));
  const parts: string[] = [];
  if (foreign.size) parts.push(`получатели вне ваших отделов: ${[...foreign].slice(0, 5).map(name).join(', ')}${foreign.size > 5 ? ` и ещё ${foreign.size - 5}` : ''}`);
  if (badDepts.length) parts.push(`отдел вне вашей иерархии (#${badDepts.join(', #')})`);
  return parts.length ? `Нельзя: ${parts.join('; ')}. Выберите сотрудников из своих отделов.` : null;
}
