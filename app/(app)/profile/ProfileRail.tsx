'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  IdCard, Users, UsersRound, Settings, ClipboardList, Contact,
  Swords, BarChart3, Medal, ShoppingBag, Package, FerrisWheel, Wallet, Zap,
} from 'lucide-react';
import { MANAGER_TABS, type ManagerTabKey } from '@/features/manager-card/ui/ManagerTabs';

// Левая рельса ЛК «а-ля VK/Facebook» (задача владельца 05.08: «левое меню как у нас
// всегда, справа контент»). Десктоп-only (`hidden lg:flex` ставит layout): на телефоне
// остаются верхняя полоса ProfileNav + горизонтальные вкладки самой карточки — они
// уже отлажены по правилам адаптивности (2779), рельса им не замена, а десктопная
// альтернатива.
//
// Вкладки карточки (?tab=) и маршруты кабинета (/profile/team и т.д.) нарочно живут
// в ОДНОМ списке: для человека это один уровень навигации, как в соцсети. Источник
// правды для вкладок — MANAGER_TABS (не дублируем список руками: новый таб карточки
// сам появится в рельсе).
//
// mode приходит с сервера (layout → resolveSelfCard): у РОПа/директора карточка
// отдела БЕЗ вкладок (tabbed=false в ManagerCardPage) — пункты-вкладки прячем,
// иначе это были бы мёртвые ссылки.

const TAB_ICONS: Record<ManagerTabKey, typeof IdCard> = {
  profile: IdCard,
  planyorka: ClipboardList,
  customers: Contact,
  quests: Swords,
  stats: BarChart3,
  rewards: Medal,
  wallet: Wallet,
  shop: ShoppingBag,
  wheel: FerrisWheel,
  inventory: Package,
};

export function ProfileRail({ mode }: { mode: 'manager' | 'department' | 'none' }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Тот же фиче-флаг и queryKey, что в ManagerCardPage — React Query дедуплицирует.
  const { data: features } = useQuery<{ planyorka: boolean }>({
    queryKey: ['features'],
    queryFn: async () => {
      const res = await fetch('/api/features');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const planyorkaEnabled = features?.planyorka ?? false;

  const tab = searchParams.get('tab');
  const items: { key: string; href: string; label: string; Icon: typeof IdCard; active: boolean }[] = [];

  if (mode === 'manager') {
    for (const t of MANAGER_TABS) {
      if (t.key === 'planyorka' && !planyorkaEnabled) continue;
      items.push({
        key: `tab:${t.key}`,
        href: t.key === 'profile' ? '/profile' : `/profile?tab=${t.key}`,
        label: t.label,
        Icon: TAB_ICONS[t.key],
        active: pathname === '/profile' && (tab === t.key || (t.key === 'profile' && !tab)),
      });
    }
  } else {
    // Отдел/без привязки: одна страница кабинета без вкладок.
    items.push({
      key: 'tab:profile', href: '/profile', label: 'Профиль', Icon: IdCard,
      active: pathname === '/profile',
    });
  }

  items.push(
    {
      key: 'team', href: '/profile/team', label: 'Мой отдел', Icon: Users,
      active: pathname.startsWith('/profile/team'),
    },
    {
      key: 'pulse', href: '/profile/pulse', label: 'Движуха', Icon: Zap,
      active: pathname.startsWith('/profile/pulse'),
    },
    {
      key: 'people', href: '/profile/people', label: 'Коллеги', Icon: UsersRound,
      active: pathname.startsWith('/profile/people'),
    },
    {
      key: 'settings', href: '/profile/settings', label: 'Настройки', Icon: Settings,
      active: pathname.startsWith('/profile/settings'),
    },
  );

  return (
    <nav className="w-56 shrink-0 flex flex-col gap-0.5 border-r border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] px-2 py-3 overflow-y-auto">
      {items.map(({ key, href, label, Icon, active }) => (
        <Link
          key={key}
          href={href}
          className={`min-h-11 flex items-center gap-2.5 rounded-lg px-3 text-sm transition-colors ${
            active
              ? 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active)] font-medium'
              : 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]'
          }`}
        >
          <Icon size={18} className="shrink-0" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
