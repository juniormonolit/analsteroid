import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Задача 3045, шаг 1: молчаливый `redirect(firstAllowedPath(session))` заменён на
// честное «недостаточно прав» НА ТОМ ЖЕ адресе (правило владельца из волны 1,
// задача 2824 — прислали ссылку на закрытый раздел, человек должен прочитать
// причину, а не оказаться неизвестно где). Скрывать пункт в меню и запрещать
// доступ — разные вещи: гейт здесь, на сервере, а не в вёрстке сайдбара.
export default async function PlansLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  // Аудит 09.09 (ACCESS_AUDIT_2026-09-09.md): раздел «Ещё» целиком — только
  // Администратор/супер-админ (правило владельца «всё — только админ; остальные —
  // свой срез»). Право section.plans ниже остаётся вторым, более тонким рычагом.
  if (!hasFullManagerAccess(session)) {
    return <AccessDenied reason="Раздел доступен только администраторам" />;
  }
  if (!hasPerm(session, 'section.plans')) {
    return <AccessDenied reason="Раздел «Планы» — планы менеджеров по месяцам и рабочий календарь. Доступ выдаёт администратор в «Настройки → Роли»." />;
  }
  return <>{children}</>;
}
