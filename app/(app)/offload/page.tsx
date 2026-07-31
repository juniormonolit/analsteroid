import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { OffloadPage } from '@/features/offload/ui/OffloadPage';

export const metadata = { title: 'Разгрузка отделов — Аналстероид' };

// Серверный гейт (в дополнение к permError в API): прямой заход по URL без
// права section.offload не должен показывать даже каркас раздела.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.offload')) {
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)]">
        Раздел «Разгрузка отделов» доступен только директору по продажам —
        попросите администратора выдать право в настройках ролей.
      </div>
    );
  }
  return <OffloadPage />;
}
