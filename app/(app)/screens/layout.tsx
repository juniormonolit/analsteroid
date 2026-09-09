import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт раздела «Телевизоры» — по паттерну presentation/layout.tsx: честное
// «недостаточно прав» на том же адресе вместо молчаливого редиректа.
export default async function ScreensLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  // Аудит 09.09 (ACCESS_AUDIT_2026-09-09.md): раздел «Ещё» целиком — только
  // Администратор/супер-админ (правило владельца «всё — только админ; остальные —
  // свой срез»). Право section.tv ниже остаётся вторым, более тонким рычагом.
  if (!hasFullManagerAccess(session)) {
    return <AccessDenied reason="Раздел доступен только администраторам" />;
  }
  if (!hasPerm(session, 'section.tv')) {
    return <AccessDenied reason="Раздел «Телевизоры» — ТВ-дашборды отделов продаж: экраны, привязка телевизоров, бегущие строки и рассылки. Доступ выдаёт администратор в «Настройки → Роли»." />;
  }
  return <>{children}</>;
}
