import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { resolveSelfCard } from '@/lib/org/selfCard';
import { ProfileNav } from './ProfileNav';
import { ProfileRail } from './ProfileRail';

// Личный кабинет (задача 3045). Правами НЕ гейтится вообще: это единственный раздел,
// доступный любому залогиненному — в т.ч. аккаунту, автосозданному при входе из
// Битрикса (роль «Пользователь», пустой набор прав). Что внутри вкладок увидит
// конкретный человек, решают их страницы и API, а не эта рельса.
//
// Компоновка «а-ля VK» (решение владельца 05.08): на десктопе слева вертикальная
// рельса со ВСЕМИ пунктами кабинета (вкладки карточки + Мой отдел/Люди/Настройки),
// контент справа. На телефоне рельсы нет — остаются верхняя полоса ProfileNav и
// горизонтальные вкладки самой карточки (отлажены по правилам 2779, не трогаем).
// mode для рельсы решает resolveSelfCard: у РОПа карточка отдела без вкладок —
// пункты-вкладки в рельсе не рисуем (были бы мёртвые ссылки).
export default async function ProfileLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const self = await resolveSelfCard(session);
  const railMode = self.kind === 'no-bitrix' ? 'none' : self.mode;

  return (
    // overflow-x-hidden рядом с overflow-y-auto — правило 13 CLAUDE.md (иначе любая
    // забытая ширина внутри вкладки утаскивает вбок всю страницу, а не себя).
    <div className="h-full flex overflow-hidden">
      <div className="hidden lg:flex shrink-0"><ProfileRail mode={railMode} /></div>
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="lg:hidden"><ProfileNav /></div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">{children}</div>
      </div>
    </div>
  );
}
