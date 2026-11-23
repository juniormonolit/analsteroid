import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canManageTemplates } from '@/features/tasker/engine/templates';
import { TemplatesPage } from '@/features/tasker/ui/templates/TemplatesPage';

export const metadata = {
  title: 'Шаблоны — Задачник — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

// Гейт раздела (section.tasker) — в layout.tsx Задачника; редактор — право action.tasker.templates
// (админ — и так). Сервер проверяет его сам в /api/tasker/templates*.
export default async function Page() {
  const session = await getSession();
  if (!session || !canManageTemplates(session)) {
    return <AccessDenied reason="Шаблоны рекомендаций правят руководители с правом «Задачник: редактировать шаблоны рекомендаций»." />;
  }
  return <TemplatesPage />;
}
