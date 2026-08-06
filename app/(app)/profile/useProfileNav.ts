'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  IdCard, Users, UsersRound, Settings, ClipboardList, Contact,
  Swords, BarChart3, Medal, ShoppingBag, Package, FerrisWheel, Wallet, Zap, Bell, ClipboardCheck,
  FileText,
} from 'lucide-react';
import { MANAGER_TABS, type ManagerTabKey } from '@/features/manager-card/ui/ManagerTabs';
import { useNotifications } from '@/features/profile/ui/NotificationsPage';

// ЕДИНЫЙ список пунктов навигации ЛК — источник правды и для десктопной рельсы
// (ProfileRail), и для мобильной строки-селектора со шторкой (ProfileMobileNav).
//
// Почему хук, а не два списка (задача «мобильная навигация ЛК», 06.08.2026):
// раньше десктоп сводил вкладки карточки (?tab=) и маршруты кабинета
// (/profile/team и т.д.) в ОДИН список, а мобильный держал две отдельные полосы
// со своей логикой — в полосе кабинета не было ни наград, ни кошелька, ни
// магазина, ни статистики, в ленте вкладок карточки — ни отдела, ни заявок, ни
// настроек. Человек искал пункт и не знал, в какой из двух полос он живёт
// (владелец со скрина PWA: «каша сверху»). Любая реализация с двумя списками
// разъезжается снова при следующей новой вкладке, поэтому список ровно один.
//
// Вкладки карточки берутся из MANAGER_TABS: новая вкладка сама появляется и в
// рельсе, и в шторке, без правок здесь.

export interface ProfileNavItem {
  key: string;
  href: string;
  label: string;
  Icon: typeof IdCard;
  active: boolean;
  badge?: number;
  /** Номер смысловой группы — по нему рисуются разделители (см. GROUP ниже). */
  group: number;
}

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

// Порядок и группировка (правка владельца 06.08: «расположи пункты меню в
// каком-то логическом порядке. Профиль сверху настройки снизу. Отчёт и
// статистика рядом. Можно чуть разделить тематические разделы межстрочным
// отступом»). Ключ → номер группы; внутри группы сохраняется порядок сборки.
// Незнакомый ключ (новая вкладка карточки) падает в группу «работа» — это
// лучше, чем исчезнуть из меню.
const GROUP: Record<string, number> = {
  'tab:profile': 0,
  'report': 1, 'tab:stats': 1,
  'tab:planyorka': 2, 'tab:customers': 2, 'tab:quests': 2,
  'tab:rewards': 3, 'tab:wallet': 3, 'tab:shop': 3, 'tab:wheel': 3, 'tab:inventory': 3,
  'team': 4, 'requests': 4, 'people': 4, 'pulse': 4,
  'notifications': 5,
  'settings': 6,
};
const DEFAULT_GROUP = 2;

/**
 * Пункты навигации ЛК в порядке групп, с флагом активности и счётчиками.
 *
 * @param mode  — приходит с сервера (layout → resolveSelfCard): у РОПа/директора
 *   карточка отдела БЕЗ вкладок (tabbed=false в ManagerCardPage), поэтому
 *   пункты-вкладки для них не строим — были бы мёртвые ссылки.
 * @param canManageRequests — «Заявки» только руководителям (решает сервер в
 *   layout, чтобы не гонять лишний запрос с клиента).
 */
export function useProfileNav({ mode, canManageRequests = false }: {
  mode: 'manager' | 'department' | 'none';
  canManageRequests?: boolean;
}): ProfileNavItem[] {
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
  // Счётчик непрочитанного у пункта «Уведомления» (механика владельца: «где-то
  // есть новое — кружочек с цифрой; увидел — погас»). Тот же queryKey, что у
  // страницы уведомлений, — React Query дедуплицирует запрос.
  const { data: notif } = useNotifications();
  const unread = notif?.unread ?? 0;

  const items: Omit<ProfileNavItem, 'group'>[] = [];

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
      key: 'report', href: '/profile/report', label: 'Мой отчёт', Icon: FileText,
      active: pathname.startsWith('/profile/report'),
    },
    {
      key: 'team', href: '/profile/team', label: 'Мой отдел', Icon: Users,
      active: pathname.startsWith('/profile/team'),
    },
    ...(canManageRequests ? [{
      key: 'requests', href: '/profile/requests', label: 'Заявки', Icon: ClipboardCheck,
      active: pathname.startsWith('/profile/requests'),
    }] : []),
    {
      key: 'pulse', href: '/profile/pulse', label: 'Движуха', Icon: Zap,
      active: pathname.startsWith('/profile/pulse'),
    },
    {
      key: 'people', href: '/profile/people', label: 'Коллеги', Icon: UsersRound,
      active: pathname.startsWith('/profile/people'),
    },
    {
      key: 'notifications', href: '/profile/notifications', label: 'Уведомления', Icon: Bell,
      active: pathname.startsWith('/profile/notifications'), badge: unread,
    },
    {
      key: 'settings', href: '/profile/settings', label: 'Настройки', Icon: Settings,
      active: pathname.startsWith('/profile/settings'),
    },
  );

  return items
    .map((it, idx) => ({ ...it, group: GROUP[it.key] ?? DEFAULT_GROUP, idx }))
    .sort((a, b) => (a.group - b.group) || (a.idx - b.idx))
    .map(({ idx: _idx, ...it }) => it);
}

/** Активный пункт — что показывать в мобильной строке-селекторе. */
export function activeProfileNavItem(items: ProfileNavItem[]): ProfileNavItem | undefined {
  return items.find(it => it.active);
}
