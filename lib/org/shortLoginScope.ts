import { analyticsDb } from '@/lib/db/clients';
import { canSeeManager, type SessionScope } from './sessionScope';

// Срез сессии в терминах short_login («#N») — ключа таблицы manager_plans.
//
// Аудит 09.09 (ai_docs/fresh_docs/ACCESS_AUDIT_2026-09-09.md, «Главные дыры» п.1
// и п.6): роуты /api/plans/* работали без среза — любой залогиненный читал планы
// всех менеджеров, а носитель action.plans.edit правил план любого сотрудника.
// Срез сессии (lib/org/sessionScope.ts) оперирует bitrix id, планы — логином;
// сопоставление одно на все роуты планов — через sa.org_resolved_hierarchy
// (short_login ↔ manager_bitrix_user_id), ровно как в lib/reports-builder/plans.ts.

/** short_login → bitrix id менеджера (активные строки оргструктуры). */
export async function loadShortLoginToBitrix(): Promise<Map<string, string>> {
  const res = await analyticsDb().query<{ short_login: string; manager_id: string }>(
    `SELECT short_login, manager_bitrix_user_id::text AS manager_id
       FROM sa.org_resolved_hierarchy
      WHERE is_active = true AND short_login IS NOT NULL AND manager_bitrix_user_id IS NOT NULL`,
  );
  return new Map(res.rows.map(r => [r.short_login, r.manager_id]));
}

/**
 * Логины, которые сессия вправе видеть/править. null — без ограничения (админ).
 * Логин без bitrix id в оргструктуре не-админу недоступен: принадлежность к срезу
 * проверить нечем.
 */
export async function scopeShortLogins(scope: SessionScope): Promise<Set<string> | null> {
  if (scope.kind === 'all') return null;
  const map = await loadShortLoginToBitrix();
  const out = new Set<string>();
  for (const [login, bitrixId] of map) {
    if (canSeeManager(scope, bitrixId)) out.add(login);
  }
  return out;
}

/** Может ли сессия трогать план конкретного логина. */
export async function canSeeShortLogin(scope: SessionScope, login: string): Promise<boolean> {
  if (scope.kind === 'all') return true;
  const map = await loadShortLoginToBitrix();
  return canSeeManager(scope, map.get(login));
}
