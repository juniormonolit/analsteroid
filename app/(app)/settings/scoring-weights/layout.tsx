import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Веса скоринга «Карточка менеджера v2» — ТОЛЬКО супер-админ, как /settings/roles,
// /settings/rights-matrix и /settings/daily-plan-mode. API (/api/settings/scoring-weights)
// уже гейтирован superadminError — этого файла раньше не было (упущение при заведении
// страницы), из-за чего вкладка не была в навигации, но открывалась по прямому URL
// любому, кто прошёл общий гейт /settings/layout.tsx (section.settings ИЛИ
// action.users.manage). Добавлено при группировке навигации настроек (бриф 09.07, п.1),
// для единообразия с остальными superadmin-only вкладками.
// Задача 2824: молчаливый redirect('/settings') заменён на явное сообщение.
export default async function ScoringWeightsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) {
    return <AccessDenied reason="Веса скоринга — раздел только для супер-администратора." />;
  }
  return <>{children}</>;
}
