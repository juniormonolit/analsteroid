'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Truck, Megaphone, UserPlus,
  ChevronDown, ChevronRight, PanelLeftClose, PanelLeft, LogOut, Settings,
  Bookmark, BookOpen, Trash2, BarChart2, ClipboardList, Network, Gauge,
} from 'lucide-react';
import type { SessionUser } from '@/lib/auth/session';
import { QueryProvider } from '@/components/providers/QueryProvider';
import { MeteorLogo } from './MeteorLogo';
import { MARKETING_PRESETS } from '@/lib/marketing/presets';
import type { SavedReport } from '@/lib/saved-reports/types';

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

  const sharedReports = savedReports.filter(r => r.isShared);
  const ownReports = savedReports.filter(r => !r.isShared && r.userLogin === user.login);

  const linkCls = (href: string) =>
    `flex items-center justify-between py-1.5 pr-2 text-sm rounded-md my-0.5 transition-colors group ${
      pathname === href
        ? 'text-[var(--color-sidebar-active)] bg-[var(--color-sidebar-active-bg)] font-medium'
        : 'text-[var(--color-sidebar-text)] hover:text-white'
    }`;

  if (collapsed) {
    return (
      <div className="flex justify-center py-1">
        <BarChart3 size={18} className="text-[var(--color-sidebar-text)]" />
      </div>
    );
  }

  return (
    <div>
      {/* Стандартные */}
      <button
        onClick={() => setOpenStd(v => !v)}
        className="w-full flex items-center gap-1 px-2 py-1 text-xs text-[var(--color-sidebar-text)] opacity-60 hover:opacity-100 transition-opacity uppercase tracking-wider"
      >
        <BookOpen size={10} />
        <span className="flex-1 text-left">Стандартные</span>
        {openStd ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      </button>
      {openStd && (
        <div className="pl-3 mb-1">
          {stdReports.map(r => (
            <Link key={r.href} href={r.href} className={linkCls(r.href)}>
              <span className="truncate">{r.label}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Смекалочная — общие отчёты (видны всем, правит только админ) */}
      {sharedReports.length > 0 && (
        <>
          <button
            onClick={() => setOpenShared(v => !v)}
            className="w-full flex items-center gap-1 px-2 py-1 text-xs text-[var(--color-sidebar-text)] opacity-60 hover:opacity-100 transition-opacity uppercase tracking-wider mt-1"
          >
            <BarChart2 size={10} />
            <span className="flex-1 text-left">Смекалочная</span>
            {openShared ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
          {openShared && (
            <div className="pl-3 mb-1">
              {sharedReports.map(r => {
                const href = `/sales/saved/${r.id}`;
                return (
                  <Link key={r.id} href={href} className={linkCls(href)}>
                    <span className="truncate flex-1">{r.name}</span>
                    {user.isAdmin && (
                      <button
                        onClick={e => deleteReport(r.id, e)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-[var(--color-negative)]"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Избранное — личные отчёты */}
      <button
        onClick={() => setOpenFav(v => !v)}
        className="w-full flex items-center gap-1 px-2 py-1 text-xs text-[var(--color-sidebar-text)] opacity-60 hover:opacity-100 transition-opacity uppercase tracking-wider mt-1"
      >
        <Bookmark size={10} />
        <span className="flex-1 text-left">Избранное</span>
        {openFav ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      </button>
      {openFav && (
        <div className="pl-3 mb-1">
          {ownReports.length === 0 ? (
            <div className="text-xs text-[var(--color-sidebar-text)] opacity-40 py-1 px-1">
              Нет сохранённых
            </div>
          ) : (
            ownReports.map(r => {
              const href = `/sales/saved/${r.id}`;
              return (
                <Link key={r.id} href={href} className={linkCls(href)}>
                  <span className="truncate flex-1">{r.name}</span>
                  <button
                    onClick={e => deleteReport(r.id, e)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-[var(--color-negative)]"
                  >
                    <Trash2 size={12} />
                  </button>
                </Link>
              );
            })
          )}
        </div>
      )}
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
}

const NAV: NavItem[] = [
  { label: 'Продажи', icon: <BarChart3 size={18} />, isSales: true },
  { label: 'Реализация', icon: <Truck size={18} />, disabled: true },
  {
    label: 'Маркетинг', icon: <Megaphone size={18} />,
    children: Object.entries(MARKETING_PRESETS).map(([key, p]) => ({
      label: p.title,
      href: `/marketing/${key}`,
    })),
  },
  { label: 'Найм', icon: <UserPlus size={18} />, disabled: true },
];

export function AppShell({ children, user }: { children: React.ReactNode; user: SessionUser }) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<string>('Продажи');
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <QueryProvider>
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside
          className="flex flex-col shrink-0 bg-[var(--color-sidebar-bg)] transition-all duration-200"
          style={{ width: collapsed ? 52 : 220 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 h-14 border-b border-white/10">
            {!collapsed && (
              <span className="flex items-center gap-2 min-w-0">
                <MeteorLogo size={24} className="shrink-0" />
                <span className="text-white font-semibold text-sm tracking-wide truncate">Аналстероид</span>
              </span>
            )}
            <button
              onClick={() => setCollapsed(v => !v)}
              className="text-[var(--color-sidebar-text)] hover:text-white p-1 rounded shrink-0"
            >
              {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
            </button>
          </div>

          {/* Nav */}
          <nav className="flex-1 overflow-y-auto py-2">
            {NAV.map(item => (
              <div key={item.label}>
                {item.disabled ? (
                  <div className="flex items-center gap-3 px-3 py-2 opacity-40 cursor-not-allowed">
                    <span className="text-[var(--color-sidebar-text)]">{item.icon}</span>
                    {!collapsed && <span className="text-sm text-[var(--color-sidebar-text)]">{item.label}</span>}
                    {!collapsed && <span className="ml-auto text-xs text-[var(--color-sidebar-text)]">soon</span>}
                  </div>
                ) : item.isSales ? (
                  <>
                    <button
                      onClick={() => setExpanded(v => v === item.label ? '' : item.label)}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors"
                    >
                      <span className="text-[var(--color-sidebar-text)]">{item.icon}</span>
                      {!collapsed && <>
                        <span className="text-sm text-[var(--color-sidebar-text)] flex-1 text-left">{item.label}</span>
                        {expanded === item.label ? <ChevronDown size={14} className="text-[var(--color-sidebar-text)]" /> : <ChevronRight size={14} className="text-[var(--color-sidebar-text)]" />}
                      </>}
                    </button>
                    {!collapsed && expanded === item.label && (
                      <div className="pl-6 pr-2 py-1">
                        <SalesSidebarSection collapsed={collapsed} pathname={pathname} user={user} />
                      </div>
                    )}
                  </>
                ) : item.children ? (
                  <>
                    <button
                      onClick={() => setExpanded(v => v === item.label ? '' : item.label)}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors"
                    >
                      <span className="text-[var(--color-sidebar-text)]">{item.icon}</span>
                      {!collapsed && <>
                        <span className="text-sm text-[var(--color-sidebar-text)] flex-1 text-left">{item.label}</span>
                        {expanded === item.label ? <ChevronDown size={14} className="text-[var(--color-sidebar-text)]" /> : <ChevronRight size={14} className="text-[var(--color-sidebar-text)]" />}
                      </>}
                    </button>
                    {!collapsed && expanded === item.label && (
                      <div className="pl-9">
                        {item.children.map(child => (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={`block py-1.5 pr-3 text-sm transition-colors rounded-md my-0.5 ${
                              pathname === child.href
                                ? 'text-[var(--color-sidebar-active)] bg-[var(--color-sidebar-active-bg)] font-medium'
                                : 'text-[var(--color-sidebar-text)] hover:text-white'
                            }`}
                          >
                            {child.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Link
                    href={item.href!}
                    className={`flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors ${
                      pathname === item.href ? 'bg-[var(--color-sidebar-active-bg)]' : ''
                    }`}
                  >
                    <span className="text-[var(--color-sidebar-text)]">{item.icon}</span>
                    {!collapsed && <span className="text-sm text-[var(--color-sidebar-text)]">{item.label}</span>}
                  </Link>
                )}
              </div>
            ))}
          </nav>

          {/* Сводная + Планы + Декомпозиция */}
          <div className="border-t border-white/10 pt-1">
            <Link
              href="/summary"
              className={`flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors ${
                pathname.startsWith('/summary') ? 'bg-[var(--color-sidebar-active-bg)]' : ''
              }`}
            >
              <span className="text-[var(--color-sidebar-text)]"><Gauge size={18} /></span>
              {!collapsed && <span className="text-sm text-[var(--color-sidebar-text)]">Сводная</span>}
            </Link>
            <Link
              href="/plans"
              className={`flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors ${
                pathname.startsWith('/plans') ? 'bg-[var(--color-sidebar-active-bg)]' : ''
              }`}
            >
              <span className="text-[var(--color-sidebar-text)]"><ClipboardList size={18} /></span>
              {!collapsed && <span className="text-sm text-[var(--color-sidebar-text)]">Планы</span>}
            </Link>
            <Link
              href="/decomposition"
              className={`flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors ${
                pathname.startsWith('/decomposition') ? 'bg-[var(--color-sidebar-active-bg)]' : ''
              }`}
            >
              <span className="text-[var(--color-sidebar-text)]"><Network size={18} /></span>
              {!collapsed && <span className="text-sm text-[var(--color-sidebar-text)]">Декомпозиция</span>}
            </Link>
          </div>

          {/* Admin: Metrics + Settings */}
          {user.isAdmin && (
            <div className="pt-1">
              <Link
                href="/metrics"
                className={`flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors ${
                  pathname.startsWith('/metrics') ? 'bg-[var(--color-sidebar-active-bg)]' : ''
                }`}
              >
                <span className="text-[var(--color-sidebar-text)]"><BarChart2 size={18} /></span>
                {!collapsed && <span className="text-sm text-[var(--color-sidebar-text)]">Метрики</span>}
              </Link>
              <Link
                href="/settings"
                className={`flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors ${
                  pathname.startsWith('/settings') ? 'bg-[var(--color-sidebar-active-bg)]' : ''
                }`}
              >
                <span className="text-[var(--color-sidebar-text)]"><Settings size={18} /></span>
                {!collapsed && <span className="text-sm text-[var(--color-sidebar-text)]">Настройки</span>}
              </Link>
            </div>
          )}

          {/* Footer */}
          <div className="border-t border-white/10 p-3">
            {!collapsed && (
              <div className="text-xs text-[var(--color-sidebar-text)] mb-2 truncate">{user.displayName}</div>
            )}
            <button
              onClick={logout}
              className="flex items-center gap-2 text-[var(--color-sidebar-text)] hover:text-white text-xs"
            >
              <LogOut size={16} />
              {!collapsed && 'Выйти'}
            </button>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 overflow-hidden flex flex-col">
          {children}
        </main>
      </div>
    </QueryProvider>
  );
}
