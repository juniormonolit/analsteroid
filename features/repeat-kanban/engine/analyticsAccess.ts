// Кто видит «Аналитику канбана повторных» (владелец 28.10: «разрешим аналитику от РОПов и выше, пусть видят»; до этого —
// директорам и выше, 20.10). Директор/админ/суперадмин — как раньше (вся компания); роль «РОП» или любой, у кого в канбане
// есть зона подчинённых (ropScope не «только сам» — то же условие, по которому доступны действия РОПа). Данные — по зоне:
// API аналитики режут менеджеров по ropScope.
import type { SessionUser } from '@/lib/auth/session';
import { canSeeRepeatKanbanAnalytics } from '@/lib/auth/modulesAccess';
import { ropScope } from '@/features/tv/engine/access';

export async function canSeeKanbanAnalytics(session: SessionUser): Promise<boolean> {
  if (canSeeRepeatKanbanAnalytics(session) || session.roleName === 'РОП') return true;
  const scope = await ropScope(session).catch(() => null);
  return !!scope && (scope.full || !scope.selfOnly);
}
