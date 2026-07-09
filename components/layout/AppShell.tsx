'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Truck, Megaphone, UserPlus,
  ChevronDown, ChevronRight, PanelLeftClose, PanelLeft, LogOut, Settings,
  Bookmark, BookOpen, Trash2, BarChart2, ClipboardList, Network, Gauge, Menu, X, Bell, Lightbulb,
} from 'lucide-react';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm, type PermKey } from '@/lib/auth/perms';
import { Avatar } from '@/components/ui/Avatar';
import { QueryProvider } from '@/components/providers/QueryProvider';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { MARKETING_PRESETS } from '@/lib/marketing/presets';
import type { SavedReport } from '@/lib/saved-reports/types';
import { ChangelogPanel } from '@/features/changelog/ui/ChangelogPanel';
import { useChangelogQuery } from '@/features/changelog/ui/useChangelogQuery';
import { IdeasPanel } from '@/features/ideas/ui/IdeasPanel';

/* Общий паттерн пункта 1-го уровня (NAV-блок, Сводная/Планы/Декомпозиция,
   Метрики/Настройки) — редизайн сайдбара, итерация 3 (бриф Виктора). */
const NAV_ITEM_BASE =
  'flex items-start gap-2.5 px-2 py-1.5 mx-1 my-0.5 rounded-lg text-sm leading-[1.35] relative transition-colors';
const NAV_ITEM_ACTIVE = 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active)] font-semibold';
const NAV_ITEM_INACTIVE = 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]';
// Левая акцентная полоска активного пункта — аналог .sb-item.active::before из мока.
const NAV_ITEM_ACTIVE_BAR =
  "before:content-[''] before:absolute before:left-[-10px] before:top-[6px] before:bottom-[6px] before:w-[3px] before:rounded-r before:bg-[var(--color-sidebar-active)]";

function navIconCls(active: boolean) {
  return active ? 'text-[var(--color-sidebar-active)] mt-px' : 'text-[var(--color-sidebar-text-muted)] mt-px';
}

// Подпись под лочапом «знак + Монолитика» (бриф ребрендинга): те же ширина
// лочапа и левый край, что у строки с названием — маленький приглушённый
// кегль, разрядка. Только в развёрнутых состояниях (сайдбар/мобильный
// drawer) — в свёрнутой рельсе показывается только знак, без текста.
const BRAND_TAGLINE_CLS =
  'block truncate text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--color-sidebar-text-muted)]';
const BRAND_TAGLINE_TEXT = '— аналитика для монолитика'.toUpperCase();

function SalesSidebarSection({ collapsed, pathname, user }: { collapsed: boolean; pathname: string; user: SessionUser }) {
  const [openStd, setOpenStd] = useState(true);
  const [openFav, setOpenFav] = useState(true);
  const [openShared, setOpenShared] = useState(true);
  const qc = useQueryClient();

  const { data: savedReports = [] } = useQuery<SavedReport[]>({
    queryKey: ['saved-reports'],
    queryFn: async () => {
      const res = await fetch('/api/saved-reports');
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 30_000,
  });

  async function deleteReport(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/saved-reports/${id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['saved-reports'] });
  }

  const stdReports = [
    { label: 'По менеджерам', href: '/sales/by-managers' },
    { label: 'По товарным группам', href: '/sales/by-product-groups' },
  ];

  // Пункт 3б спеки: две управляемые общие витрины, одна механика (is_shared),
  // разные разделы (shared_section). Удаление из общих разделов — только супер-админ.
  const ropMonitorShared = savedReports.filter(r => r.isShared && r.sharedSection === 'rop_monitor');
  const smekalochnayaShared = savedReports.filter(r => r.isShared && r.sharedSection === 'smekalochnaya');
  const ownReports = savedReports.filter(r => !r.isShared && r.userLogin === user.login);
  const canDeleteShared = user.isSuperadmin;

  // Направляющая линия вложенности вокруг под-группы (Роп монитор / Смекалочная / Избранное).
  const subgroupCls = 'ml-5 pl-2.5 mb-2.5 border-l border-[var(--color-sidebar-guide)]';
  const subgroupLabelCls =
    'w-full flex items-center gap-1.5 px-1 py-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] transition-colors';

  const linkCls = (href: string) =>
    `flex items-start gap-1.5 py-1 px-2 my-0.5 text-[13px] leading-[1.35] rounded-[7px] relative transition-colors group ${
      pathname === href
        ? "text-[var(--color-sidebar-active)] bg-[var(--color-sidebar-active-bg)] font-semibold before:content-[''] before:absolute before:left-[-11px] before:top-[5px] before:bottom-[5px] before:w-[2px] before:rounded-[2px] before:bg-[var(--color-sidebar-active)]"
        : 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]'
    }`;

  const delBtnCls =
    'hover-reveal tap-target absolute right-1 top-1 p-0.5 rounded-[5px] bg-[var(--color-sidebar-hover-bg)] text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-negative)]';

  if (collapsed) {
    return (
      <div className="flex justify-center py-1">
        <BarChart3 size={18} className="text-[var(--color-sidebar-text-muted)]" />
      </div>
    );
  }

  return (
    <div>
      {/* Роп монитор — стандартные + общие отчёты витрины rop_monitor */}
      <div className={subgroupCls}>
        <button onClick={() => setOpenStd(v => !v)} className={subgroupLabelCls}>
          <BookOpen size={11} />
          <span className="flex-1 text-left">Роп монитор</span>
          {openStd ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {openStd && (
          <>
            {stdReports.map(r => (
              <Link key={r.href} href={r.href} className={linkCls(r.href)}>
                <span className="flex-1 min-w-0 break-words line-clamp-2">{r.label}</span>
              </Link>
            ))}
            {ropMonitorShared.map(r => {
              const href = `/sales/saved/${r.id}`;
              return (
                <Link key={r.id} href={href} className={linkCls(href)} title={r.name}>
                  <span className="flex-1 min-w-0 break-words line-clamp-2">{r.name}</span>
                  {canDeleteShared && (
                    <button onClick={e => deleteReport(r.id, e)} className={delBtnCls}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </Link>
              );
            })}
          </>
        )}
      </div>

      {/* Смекалочная — общие отчёты (видны всем, сохраняет/перезаписывает админ,
          удаляет только супер-админ) */}
      {smekalochnayaShared.length > 0 && (
        <div className={subgroupCls}>
          <button onClick={() => setOpenShared(v => !v)} className={subgroupLabelCls}>
            <BarChart2 size={11} />
            <span className="flex-1 text-left">Отчёты Стаса</span>
            {openShared ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
          {openShared && smekalochnayaShared.map(r => {
            const href = `/sales/saved/${r.id}`;
            return (
              <Link key={r.id} href={href} className={linkCls(href)} title={r.name}>
                <span className="flex-1 min-w-0 break-words line-clamp-2">{r.name}</span>
                {canDeleteShared && (
                  <button onClick={e => deleteReport(r.id, e)} className={delBtnCls}>
                    <Trash2 size={12} />
                  </button>
                )}
              </Link>
            );
          })}
        </div>
      )}

      {/* Избранное — личные отчёты */}
      <div className={subgroupCls}>
        <button onClick={() => setOpenFav(v => !v)} className={subgroupLabelCls}>
          <Bookmark size={11} />
          <span className="flex-1 text-left">Избранное</span>
          {openFav ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {openFav && (
          ownReports.length === 0 ? (
            <div className="text-xs text-[var(--color-sidebar-text-muted)] py-1 px-1">
              Нет сохранённых
            </div>
          ) : (
            ownReports.map(r => {
              const href = `/sales/saved/${r.id}`;
              return (
                <Link key={r.id} href={href} className={linkCls(href)} title={r.name}>
                  <span className="flex-1 min-w-0 break-words line-clamp-2">{r.name}</span>
                  <button onClick={e => deleteReport(r.id, e)} className={delBtnCls}>
                    <Trash2 size={12} />
                  </button>
                </Link>
              );
            })
          )
        )}
      </div>
    </div>
  );
}

interface NavItem {
  label: string;
  href?: string;
  icon: React.ReactNode;
  disabled?: boolean;
  isSales?: boolean;
  children?: { label: string; href: string }[];
  perm?: PermKey; // без права — пункт не показывается
}

const NAV: NavItem[] = [
  { label: 'Продажи', icon: <BarChart3 size={18} />, isSales: true, perm: 'section.sales' },
  { label: 'Реализация', icon: <Truck size={18} />, disabled: true },
  {
    label: 'Маркетинг', icon: <Megaphone size={18} />, perm: 'section.marketing',
    children: Object.entries(MARKETING_PRESETS).map(([key, p]) => ({
      label: p.title,
      href: `/marketing/${key}`,
    })),
  },
  { label: 'Найм', icon: <UserPlus size={18} />, disabled: true },
];

/* Содержимое сайдбара (nav + нижние секции + footer) — общее для десктопного
   <aside> и мобильного off-canvas drawer, поэтому вынесено из AppShell. */
function SidebarBody({
  collapsed, pathname, user, expanded, setExpanded, logout,
  changelogOpen, onOpenChangelog, ideasOpen, onOpenIdeas,
}: {
  collapsed: boolean;
  pathname: string;
  user: SessionUser;
  expanded: string;
  setExpanded: React.Dispatch<React.SetStateAction<string>>;
  logout: () => void;
  changelogOpen: boolean;
  onOpenChangelog: () => void;
  ideasOpen: boolean;
  onOpenIdeas: () => void;
}) {
  const salesActive = pathname.startsWith('/sales');
  const showSummaryBlock = hasPerm(user, 'section.summary') || hasPerm(user, 'section.plans') || hasPerm(user, 'section.decomposition');
  const showMetricsBlock = hasPerm(user, 'section.metrics') || hasPerm(user, 'section.settings');
  // «Что изменилось?» — пункт внизу сайдбара (задача владельца, макет
  // changelog-notifications-mock.html): доступен всем, независимо от ролей/прав.
  const { data: changelogData } = useChangelogQuery();
  const unreadCount = changelogData?.unreadCount ?? 0;

  return (
    <>
          {/* Nav */}
          <nav className="flex-1 overflow-y-auto py-2 px-2">
            {NAV.filter(item => !item.perm || hasPerm(user, item.perm)).map(item => (
              <div key={item.label}>
                {item.disabled ? (
                  <div className={`${NAV_ITEM_BASE} cursor-not-allowed`}>
                    <span className="mt-px text-[#ced4da]">{item.icon}</span>
                    {!collapsed && (
                      <span className="flex-1 min-w-0 break-words line-clamp-2 text-[var(--color-sidebar-text-muted)]">
                        {item.label}
                      </span>
                    )}
                    {!collapsed && (
                      <span className="ml-auto mt-px shrink-0 text-[10px] font-semibold text-[var(--color-sidebar-text-muted)] bg-[var(--color-bg)] border border-[var(--color-sidebar-border)] rounded-full px-2 py-0.5">
                        Скоро
                      </span>
                    )}
                  </div>
                ) : item.isSales ? (
                  <>
                    <button
                      onClick={() => setExpanded(v => v === item.label ? '' : item.label)}
                      className={`w-full ${NAV_ITEM_BASE} ${salesActive ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                    >
                      <span className={navIconCls(salesActive)}>{item.icon}</span>
                      {!collapsed && <>
                        <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">{item.label}</span>
                        {expanded === item.label
                          ? <ChevronDown size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />
                          : <ChevronRight size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />}
                      </>}
                    </button>
                    {!collapsed && expanded === item.label && (
                      <div className="py-1">
                        <SalesSidebarSection collapsed={collapsed} pathname={pathname} user={user} />
                      </div>
                    )}
                  </>
                ) : item.children ? (
                  <>
                    <button
                      onClick={() => setExpanded(v => v === item.label ? '' : item.label)}
                      className={`w-full ${NAV_ITEM_BASE} ${NAV_ITEM_INACTIVE}`}
                    >
                      <span className={navIconCls(false)}>{item.icon}</span>
                      {!collapsed && <>
                        <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">{item.label}</span>
                        {expanded === item.label
                          ? <ChevronDown size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />
                          : <ChevronRight size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />}
                      </>}
                    </button>
                    {!collapsed && expanded === item.label && (
                      <div className="ml-5 pl-2.5 mb-2.5 border-l border-[var(--color-sidebar-guide)]">
                        {item.children.map(child => {
                          const active = pathname === child.href;
                          return (
                            <Link
                              key={child.href}
                              href={child.href}
                              className={`flex items-start gap-1.5 py-1 px-2 my-0.5 text-[13px] leading-[1.35] rounded-[7px] relative transition-colors ${
                                active
                                  ? "text-[var(--color-sidebar-active)] bg-[var(--color-sidebar-active-bg)] font-semibold before:content-[''] before:absolute before:left-[-11px] before:top-[5px] before:bottom-[5px] before:w-[2px] before:rounded-[2px] before:bg-[var(--color-sidebar-active)]"
                                  : 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]'
                              }`}
                            >
                              <span className="flex-1 min-w-0 break-words line-clamp-2">{child.label}</span>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <Link
                    href={item.href!}
                    className={`${NAV_ITEM_BASE} ${pathname === item.href ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                  >
                    <span className={navIconCls(pathname === item.href)}>{item.icon}</span>
                    {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">{item.label}</span>}
                  </Link>
                )}
              </div>
            ))}
          </nav>

          {/* Сводная + Планы + Декомпозиция — рендерим блок целиком только если
              есть право хотя бы на один из трёх пунктов, иначе на светлой панели
              висит одинокая линия-разделитель над футером у обычных юзеров. */}
          {showSummaryBlock && (
            <div className="border-t border-[var(--color-sidebar-border)] pt-1 px-2">
              {hasPerm(user, 'section.summary') && (
                <Link
                  href="/summary"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/summary') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/summary'))}><Gauge size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Сводная</span>}
                </Link>
              )}
              {hasPerm(user, 'section.plans') && (
                <Link
                  href="/plans"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/plans') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/plans'))}><ClipboardList size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Планы</span>}
                </Link>
              )}
              {hasPerm(user, 'section.decomposition') && (
                <Link
                  href="/decomposition"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/decomposition') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/decomposition'))}><Network size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Декомпозиция</span>}
                </Link>
              )}
            </div>
          )}

          {/* Метрики + Настройки — по правам */}
          {showMetricsBlock && (
            <div className="pt-1 px-2">
              {hasPerm(user, 'section.metrics') && (
                <Link
                  href="/metrics"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/metrics') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/metrics'))}><BarChart2 size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Метрики</span>}
                </Link>
              )}
              {hasPerm(user, 'section.settings') && (
                <Link
                  href="/settings"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/settings') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/settings'))}><Settings size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Настройки</span>}
                </Link>
              )}
            </div>
          )}

          {/* «Идеи и планы» — бэклог идей (макет ideas-backlog-mock.html), НАД
              «Что изменилось?», виден всем независимо от прав, как и ченджлог. */}
          <div className="pt-1 px-2">
            <button
              type="button"
              onClick={onOpenIdeas}
              className={`w-full ${NAV_ITEM_BASE} ${ideasOpen ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
            >
              <span className={navIconCls(ideasOpen)}><Lightbulb size={18} /></span>
              {!collapsed && (
                <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">Идеи и планы</span>
              )}
            </button>
          </div>

          {/* «Что изменилось?» — ченджлог, виден всем независимо от прав (п.4 задачи) */}
          <div className="pt-1 px-2">
            <button
              type="button"
              onClick={onOpenChangelog}
              className={`w-full ${NAV_ITEM_BASE} ${changelogOpen ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
            >
              <span className={navIconCls(changelogOpen)}><Bell size={18} /></span>
              {!collapsed && (
                <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">Что изменилось?</span>
              )}
              {!collapsed && unreadCount > 0 && (
                <span className="ml-auto mt-px shrink-0 min-w-[18px] h-[18px] px-1.5 rounded-full bg-[var(--color-negative)] text-white text-[10.5px] font-bold flex items-center justify-center shadow-[0_0_0_2px_var(--color-sidebar-bg)] leading-none">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          </div>

          {/* Footer: карточка юзера (аватар + имя/роль) → ЛК, рядом «Выйти» */}
          <div className="border-t border-[var(--color-sidebar-border)] p-2">
            <div className={`flex items-center gap-1 ${collapsed ? 'flex-col' : ''}`}>
              <Link
                href="/profile"
                className={`flex items-center gap-2 min-w-0 flex-1 rounded-[9px] px-1.5 py-1.5 transition-colors hover:bg-[var(--color-sidebar-hover-bg)] ${collapsed ? 'justify-center flex-none' : ''}`}
                title="Личный кабинет"
              >
                <span className="rounded-full shrink-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                  <Avatar name={user.displayName} url={user.avatarUrl} size={30} />
                </span>
                {!collapsed && (
                  <span className="min-w-0 flex flex-col gap-px">
                    <span className="text-[12.5px] font-semibold text-[var(--color-sidebar-text)] truncate">{user.displayName}</span>
                    {user.roleName && (
                      <span className="text-[11px] text-[var(--color-sidebar-text-muted)] truncate">{user.roleName}</span>
                    )}
                  </span>
                )}
              </Link>
              <button
                onClick={logout}
                className="tap-target flex items-center justify-center text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-negative)] hover:bg-[#fcebeb] rounded-md p-1.5 shrink-0 transition-colors"
                title="Выйти"
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
    </>
  );
}

export function AppShell({ children, user }: { children: React.ReactNode; user: SessionUser }) {
  const pathname = usePathname();
  // Главная открывается со свёрнутой рельсой-сайдбаром (бриф Главной,
  // analsteroid-home-mock.html) — только дефолт первого рендера; дальше
  // пользователь разворачивает/сворачивает вручную как обычно, и это не
  // перетирается при последующих клиентских переходах на/с главной.
  const [collapsed, setCollapsed] = useState(() => pathname === '/home');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<string>('Продажи');
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [ideasOpen, setIdeasOpen] = useState(false);
  const router = useRouter();

  // Переход по ссылке из мобильного меню должен закрывать drawer
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <QueryProvider>
      <div className="flex h-dvh overflow-hidden">
        {/* Desktop sidebar (на <md скрыт — вместо него drawer) */}
        <aside
          className="hidden md:flex flex-col shrink-0 bg-[var(--color-sidebar-bg)] border-r border-[var(--color-sidebar-border)] transition-all duration-200"
          style={{ width: collapsed ? 52 : 260 }}
        >
          {/* Header — клик по лого/названию ведёт на Главную (бриф Главной).
              Свёрнутая рельса (52px) слишком узкая для лого+кнопки в один ряд —
              складываем в две строки, как rail-logo/rail-expand в утверждённом
              макете (analsteroid-home-mock.html), но toggle оставлен наверху,
              а не внизу у аватара — не переносим существующий механизм. */}
          <div
            className={
              collapsed
                ? 'flex flex-col items-center justify-center gap-1.5 py-2.5 min-h-14 border-b border-[var(--color-sidebar-border)]'
                : 'flex items-start justify-between gap-2 px-3 py-2.5 border-b border-[var(--color-sidebar-border)]'
            }
          >
            {collapsed ? (
              <Link href="/home" title="Монолитика — на главную">
                <BrandLogo size={18} />
              </Link>
            ) : (
              <div className="min-w-0">
                <Link href="/home" className="flex items-center gap-2 min-w-0" title="На главную">
                  <BrandLogo size={22} className="shrink-0" />
                  <span className="text-[var(--color-sidebar-text)] font-semibold text-sm tracking-wide truncate">Монолитика</span>
                </Link>
                <span className={BRAND_TAGLINE_CLS}>{BRAND_TAGLINE_TEXT}</span>
              </div>
            )}
            <button
              onClick={() => setCollapsed(v => !v)}
              className="text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)] p-1 rounded-md shrink-0 transition-colors mt-0.5"
            >
              {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
            </button>
          </div>
          <SidebarBody
            collapsed={collapsed} pathname={pathname} user={user}
            expanded={expanded} setExpanded={setExpanded} logout={logout}
            changelogOpen={changelogOpen} onOpenChangelog={() => setChangelogOpen(true)}
            ideasOpen={ideasOpen} onOpenIdeas={() => setIdeasOpen(true)}
          />
        </aside>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
            <aside className="relative flex flex-col h-full w-[260px] max-w-[80vw] bg-[var(--color-sidebar-bg)] shadow-[0_0_24px_rgba(0,0,0,0.12)]">
              <div className="flex items-start justify-between gap-2 px-3 py-2.5 border-b border-[var(--color-sidebar-border)] shrink-0">
                <div className="min-w-0">
                  <Link href="/home" className="flex items-center gap-2 min-w-0" title="На главную">
                    <BrandLogo size={22} className="shrink-0" />
                    <span className="text-[var(--color-sidebar-text)] font-semibold text-sm tracking-wide truncate">Монолитика</span>
                  </Link>
                  <span className={BRAND_TAGLINE_CLS}>{BRAND_TAGLINE_TEXT}</span>
                </div>
                <button
                  onClick={() => setMobileOpen(false)}
                  className="tap-target text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)] p-1 rounded-md shrink-0 transition-colors mt-0.5"
                >
                  <X size={18} />
                </button>
              </div>
              <SidebarBody
                collapsed={false} pathname={pathname} user={user}
                expanded={expanded} setExpanded={setExpanded} logout={logout}
                changelogOpen={changelogOpen} onOpenChangelog={() => setChangelogOpen(true)}
                ideasOpen={ideasOpen} onOpenIdeas={() => setIdeasOpen(true)}
              />
            </aside>
          </div>
        )}

        {/* Main */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Mobile topbar */}
          <div className="md:hidden flex items-center gap-1.5 h-12 px-2 bg-[var(--color-sidebar-bg)] border-b border-[var(--color-sidebar-border)] shrink-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="tap-target text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] p-2 rounded"
              aria-label="Открыть меню"
            >
              <Menu size={20} />
            </button>
            <Link href="/home" className="flex items-center gap-1.5 min-w-0" title="На главную">
              <BrandLogo size={20} className="shrink-0" />
              <span className="text-[var(--color-sidebar-text)] font-semibold text-sm tracking-wide truncate">Монолитика</span>
            </Link>
          </div>
          <main className="flex-1 overflow-hidden flex flex-col">
            {children}
          </main>
        </div>
      </div>
      {changelogOpen && <ChangelogPanel onClose={() => setChangelogOpen(false)} />}
      {ideasOpen && <IdeasPanel onClose={() => setIdeasOpen(false)} />}
    </QueryProvider>
  );
}
