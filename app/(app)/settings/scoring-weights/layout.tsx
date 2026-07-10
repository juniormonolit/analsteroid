import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Веса скоринга «Карточка менеджера v2» — ТОЛЬКО супер-админ, как /settings/roles,
// /settings/rights-matrix и /settings/daily-plan-mode. API (/api/settings/scoring-weights)
// уже гейтирован superadminError — этого файла раньше не было (упущение при заведении
// страницы), из-за чего вкладка не была в навигации, но открывалась по прямому URL
// любому, кто прошёл общий гейт /settings/layout.tsx (section.settings ИЛИ
// action.users.manage). Добавлено при группировке навигации настроек (бриф 09.07, п.1),
// для единообразия с остальными superadmin-only вкладками.
export default async function ScoringWeightsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) redirect('/settings');
  return <>{children}</>;
}
