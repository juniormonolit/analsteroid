import type { SessionUser } from './session';
import { systemDb } from '../db/clients';

// Аудит безопасности 29.09 (#8256, находка A1): держатель action.users.manage
// (роль «Администратор») мог выключить супер-админа, переприслать ему
// приглашение, получить ссылку в ответе API, задать пароль и войти под ним.
// Правило: учётку супер-админа меняет только супер-админ. Проверка — на каждой
// ручке /api/admin/users/[id]/*, которая меняет пользователя или выдаёт доступ.
//
// null — можно продолжать (в т.ч. если пользователя нет: 404 отдаст сама ручка);
// иначе готовый ответ 403.
export async function superadminTargetError(session: SessionUser | null, targetId: string): Promise<Response | null> {
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.isSuperadmin) return null;
  const res = await systemDb().query<{ is_superadmin: boolean }>(
    `SELECT is_superadmin FROM users WHERE id = $1`,
    [targetId],
  );
  if (res.rows[0]?.is_superadmin) {
    return Response.json({ error: 'Учётку супер-админа может менять только супер-админ' }, { status: 403 });
  }
  return null;
}
