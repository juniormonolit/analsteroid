import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { ProfileNav } from './ProfileNav';

// Личный кабинет (задача 3045). Правами НЕ гейтится вообще: это единственный раздел,
// доступный любому залогиненному — в т.ч. аккаунту, автосозданному при входе из
// Битрикса (роль «Пользователь», пустой набор прав). Что внутри вкладок увидит
// конкретный человек, решают их страницы и API, а не эта рельса.
export default async function ProfileLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    // overflow-x-hidden рядом с overflow-y-auto — правило 13 CLAUDE.md (иначе любая
    // забытая ширина внутри вкладки утаскивает вбок всю страницу, а не себя).
    <div className="h-full flex flex-col overflow-hidden">
      <ProfileNav />
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">{children}</div>
    </div>
  );
}
