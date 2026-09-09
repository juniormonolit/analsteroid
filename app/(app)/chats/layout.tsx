import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Аудит 09.09 (ai_docs/fresh_docs/ACCESS_AUDIT_2026-09-09.md): «Чаты по сделкам» — раздел
// меню «Ещё», а весь «Ещё» по правилу владельца доступен только Администратору/
// супер-админу («всё — только админ; остальные — свой срез»). Серверный гейт
// по образцу settings/layout.tsx: честное «недостаточно прав» на том же адресе.
// Собственные проверки page.tsx (если есть) остаются как есть — не дублируем.
export default async function ChatsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session)) {
    return <AccessDenied reason="Раздел доступен только администраторам" />;
  }
  return <>{children}</>;
}
