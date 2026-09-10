import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// До RBAC у /metrics не было серверного гейта вообще (страница только пряталась из сайдбара).
// Задача 3045, шаг 1: молчаливый `redirect(firstAllowedPath(session))` заменён на
// честное «недостаточно прав» НА ТОМ ЖЕ адресе (правило владельца из волны 1,
// задача 2824 — прислали ссылку на закрытый раздел, человек должен прочитать
// причину, а не оказаться неизвестно где). Скрывать пункт в меню и запрещать
// доступ — разные вещи: гейт здесь, на сервере, а не в вёрстке сайдбара.
export default async function MetricsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  // Гейт пункта меню «Ещё» (задача Иосифа 10.09): администратор (аудит 09.09)
  // ИЛИ явное право роли из «Настройки → Матрица прав».
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.metrics')) {
    return <AccessDenied reason="Раздел «Метрики» — конструктор показателей, на которых считаются все отчёты. Доступ выдаёт администратор в «Настройки → Роли»." />;
  }
  return <>{children}</>;
}
