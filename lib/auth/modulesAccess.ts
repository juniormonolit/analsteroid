import type { SessionUser } from './session';
import { hasPerm } from './perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

/** Доступ к API раздела «Модули» — зеркало гейта app/(app)/modules/layout.tsx. */
export function canUseModules(session: SessionUser): boolean {
  return hasFullManagerAccess(session) || hasPerm(session, 'section.modules');
}

/**
 * Единая «Карточка клиента» внутри Монолитики (владелец 20.10: две карточки — в одну).
 * Кроме админов/права «Модули», карточку открывает любой, кому виден ВЛАДЕЛЕЦ клиента:
 * менеджер последней сделки по тому же контакту/компании (правило атрибуции, как в
 * /api/customers/journey) должен быть в срезе сессии (lib/org/sessionScope).
 */
export async function canSessionSeeClientRef(session: SessionUser, ref: string): Promise<boolean> {
  if (canUseModules(session)) return true;
  const m = /^([ck])(\d{1,12})$/.exec(ref);
  if (!m) return false;
  const { getSessionScope, canSeeManager } = await import('@/lib/org/sessionScope');
  const scope = await getSessionScope(session);
  if (scope.kind === 'all') return true;
  const { analyticsDb } = await import('@/lib/db/clients');
  const owner = await analyticsDb().query<{ mgr: string | null }>(
    `SELECT d.current_manager_id::text AS mgr FROM sa.deals d
      WHERE ${m[1] === 'k' ? 'd.company_id' : 'd.contact_id'} = $1 AND d.funnel_id IN (0,1,2,3)
      ORDER BY d.created_at DESC, d.deal_id DESC LIMIT 1`,
    [Number(m[2])],
  );
  return canSeeManager(scope, owner.rows[0]?.mgr);
}

/** «Аналитика канбана повторных» — директорам и выше (владелец 20.10): роли «Директор»,
 *  «Администратор» и суперадмин. РОП и менеджер работают на доске, аналитика — не им. */
export function canSeeRepeatKanbanAnalytics(session: Pick<SessionUser, 'isSuperadmin' | 'roleName'>): boolean {
  return session.isSuperadmin || session.roleName === 'Администратор' || session.roleName === 'Директор';
}

/** «Настройки канбана повторных» (норма задач, шаблоны сообщений) — только админам
 *  (владелец 21.10): суперадмин или роль «Администратор». Читать шаблоны и норму может
 *  любой с доступом к доске — это гейт только на ИЗМЕНЕНИЕ. */
export function canManageRepeatKanbanSettings(session: Pick<SessionUser, 'isSuperadmin' | 'roleName'>): boolean {
  return session.isSuperadmin || session.roleName === 'Администратор';
}
