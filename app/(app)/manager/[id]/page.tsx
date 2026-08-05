import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canViewManager, hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { ManagerCardPage } from '@/features/manager-card/ui/ManagerCardPage';

// ЛК менеджера: /manager/<bitrix_user_id> — карточка менеджера;
// /manager/<dept uuid|all>?mode=department — карточка отдела (агрегат).
// Начальный период можно передать через ?from&to (ISO) — так делают точки входа
// из отчётов, чтобы карточка открылась на том же периоде.
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const sp = await searchParams;
  const mode = sp.mode === 'department' ? 'department' as const : 'manager' as const;

  // Свой собственный id → ЛК (задача 3045). Закрывает сразу три вещи:
  //   • §6 п.6 спеки: ссылка в дайджесте бота (`/manager/{bitrixId}?tab=...`) у самого
  //     менеджера ведёт на его карточку — теперь она приводит в кабинет, а не создаёт
  //     второй вход в него. Шаблон дайджеста при этом НЕ трогаем: он один и тот же для
  //     менеджера и для админа, открывающего чужой дайджест на превью, — а редирект
  //     срабатывает ровно у того, чей это id;
  //   • давнюю занозу (задача 2771): человек, вручную открывший `/manager/<свой_id>`,
  //     получал карточку с isSelf=false — без магазина, гачи и переводов;
  //   • закладки на собственную карточку, оставшиеся до переезда адресов.
  // Параметры сохраняем — на них завязаны точки входа из отчётов и дайджеста.
  if (mode === 'manager' && session.bitrixUserId && session.bitrixUserId === id) {
    const qs = new URLSearchParams(
      Object.entries(sp).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])),
    ).toString();
    redirect(qs ? `/profile?${qs}` : '/profile');
  }
  const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

  // Доступ (задача 30.07, «Вариант Б»): менеджер — только себя, РОП — свой отдел,
  // руководство — всех. Второй рубеж — в /api/manager-card/* (lib/org/managerAccess.ts).
  const allowed = mode === 'manager'
    ? await canViewManager(session, id)
    : hasFullManagerAccess(session) || id === 'my' || id === 'all'
      || (await managedDepartmentIds(session)).includes(id);
  if (!allowed) {
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)]">
        Эта карточка вам недоступна. Своя — в личном кабинете (пункт «Мой кабинет» в меню).
      </div>
    );
  }

  // showBadges = «это буквально я сам» (задача 2771, попутный багфикс той же
  // природы, что showBadges в app/(embed)/bx/manager/page.tsx, задача 2764):
  // раньше здесь showBadges НИКОГДА не передавался, то есть если человек
  // вручную открывал /manager/<свой_id> вместо /manager/me — isSelf=false
  // и собственные self-service кнопки (магазин/гача/переводы) не показывались,
  // хотя ManagerCardPage у себя корректно их бы дал. Для чужой карточки
  // (обычный случай) ничего не изменилось — isOwnId=false, как и раньше.
  const isOwnId = mode === 'manager' && session.bitrixUserId === id;

  // Read-only режим (задача 2771 — Серёга зашёл с телефона как админ, увидел
  // пустой ЛК, попросил список сотрудников с переходом в чужой ЛК): ссылка из
  // этого списка ведёт сюда с ?view=readonly — ManagerCardPage тогда прячет
  // «Ручные операции» (поощрить/оштрафовать) даже у admin/director+, которым
  // canManualFor() их в принципе разрешает. Существующий путь «Моя команда»
  // (DeptRosterGrid) этот параметр не ставит — ROП по-прежнему может поощрять
  // своих подчинённых оттуда, ничего не отнято. Сам параметр может только
  // ОГРАНИЧИТЬ показ, не расширить — принимаем его от кого угодно без проверки роли.
  const forceReadOnly = sp.view === 'readonly';

  return (
    <ManagerCardPage
      managerId={id}
      mode={mode}
      managerName={str(sp.name)}
      initialFrom={str(sp.from)}
      initialTo={str(sp.to)}
      showBadges={isOwnId}
      forceReadOnly={forceReadOnly}
    />
  );
}
