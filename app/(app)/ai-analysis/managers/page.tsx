import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { ManagersSummary } from '@/features/ai-analysis/ui/ManagersSummary';

// Сводка по менеджерам из отчётов ИИ-анализа звонков (этап 2). Право — то же, что у вкладки
// «ИИ-анализ» (роль «РОП»; все РОПы видят всё — решение владельца 22.10). Вход — ссылкой из вкладки.
export const metadata = { title: 'ИИ-анализ: сводка по менеджерам — Монолитика' };

export default async function Page() {
  const session = await getSession();
  if (!hasPerm(session, 'action.ai_call_analysis')) return <AccessDenied reason="Сводка ИИ-анализа доступна РОПам (право «ИИ-анализ звонков заказчика»)." />;
  return <ManagersSummary />;
}
