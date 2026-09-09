import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { ScenarioEditor } from '@/features/bots/ui/ScenarioEditor';

// Редактор сценария авто-коучинга (конструктор цепочек бота «Аналитик»): отдельная
// страница на всю ширину — решение владельца 09.09 («не в попапе»). id = 'new' —
// новый сценарий, создаётся в БД при первом сохранении (выключенным).
export const metadata = { title: 'Сценарий бота «Аналитик» — Монолитика' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.isSuperadmin) {
    return <AccessDenied reason="Сценарии бота «Аналитик» настраивает только супер-администратор." />;
  }
  const { id } = await params;
  return <ScenarioEditor id={id} />;
}
