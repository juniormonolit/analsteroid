import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Гейт раздела «Телевизоры» — по паттерну presentation/layout.tsx: честное
// «недостаточно прав» на том же адресе вместо молчаливого редиректа.
export default async function ScreensLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.tv')) {
    return <AccessDenied reason="Раздел «Телевизоры» — ТВ-дашборды отделов продаж: экраны, привязка телевизоров, бегущие строки и рассылки. Доступ выдаёт администратор в «Настройки → Роли»." />;
  }
  return <>{children}</>;
}
