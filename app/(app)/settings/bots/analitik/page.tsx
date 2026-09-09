import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { AnalitikSettingsPage } from '@/features/bots/ui/AnalitikSettingsPage';

// Настройки бота «Аналитик»: функции + расписания рассылки отчётов (задача 09.09).
// Только супер-админ: рубильники решают, что бот пишет ЛЮДЯМ — это уровень владельца,
// не администратора справочников (тот же гейт, что у API реестра функций).
export const metadata = { title: 'Бот «Аналитик» — Монолитика' };

export default async function Page() {
  const session = await getSession();
  if (!session?.isSuperadmin) {
    return <AccessDenied reason="Функции бота «Аналитик» и расписания рассылок настраивает только супер-администратор." />;
  }
  return <AnalitikSettingsPage />;
}
