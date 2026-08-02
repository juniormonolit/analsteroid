import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/auth/session';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { hasPerm } from '@/lib/auth/perms';
import { ManagerCardPage } from '@/features/manager-card/ui/ManagerCardPage';

// «Мой ЛК» (/manager/me): РОП/директор видит агрегат своих отделов по оргструктуре
// робота «Контроль звонков» (ручные назначения приоритетнее битриксовой структуры —
// решение владельца 29.07); менеджер — собственную карточку.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.bitrixUserId) {
    // Прямая ссылка на настройки пользователей (задача 2771 — Серёга сам
    // попал в этот текст, зайдя админом без привязки к Битриксу; текст
    // раньше только НАЗЫВАЛ раздел, но не вёл в него). Ссылку показываем
    // только тем, кто реально может дойти — тот же гейт, что у самого API
    // управления пользователями (action.users.manage, app/api/admin/users) —
    // иначе тупик «нет прав» вместо «нет ЛК»; остальным — прежний текст без
    // ссылки, что и так корректно.
    const canFix = hasPerm(session, 'action.users.manage');
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)]">
        Аккаунт не связан с Битриксом — {canFix ? (
          <>
            укажите Bitrix ID в <Link href="/settings/users" className="text-[var(--color-accent)] hover:underline font-semibold">настройках пользователей</Link>,
          </>
        ) : (
          'попросите администратора указать Bitrix ID в настройках пользователей,'
        )} и здесь появится ваш ЛК.
      </div>
    );
  }

  const managed = await getCallControlManagedDepts(session.bitrixUserId);
  if (managed.length > 0) {
    return (
      <ManagerCardPage
        managerId="my"
        mode="department"
        managerName={managed.length === 1 ? (managed[0].deptName ?? 'Мой отдел') : `Мои отделы (${managed.length})`}
        showBadges
      />
    );
  }
  return <ManagerCardPage managerId={session.bitrixUserId} mode="manager" managerName={session.displayName} showBadges />;
}
