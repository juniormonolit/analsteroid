'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BarChart3, Users, Truck, Megaphone, UserPlus,
  ChevronDown, ChevronRight, PanelLeftClose, PanelLeft, LogOut,
} from 'lucide-react';
import type { SessionUser } from '@/lib/auth/session';
import { QueryProvider } from '@/components/providers/QueryProvider';

interface NavItem {
  label: string;
  href?: string;
  icon: React.ReactNode;
  disabled?: boolean;
  children?: { label: string; href: string }[];
}

const NAV: NavItem[] = [
  { label: 'Продажи', icon: <BarChart3 size={18} />, children: [
    { label: 'По менеджерам', href: '/sales/by-managers' },
    { label: 'По товарным группам', href: '/sales/by-product-groups' },
  ]},
  { label: 'Реализация', icon: <Truck size={18} />, disabled: true },
  { label: 'Маркетинг', icon: <Megaphone size={18} />, disabled: true },
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
              <span className="text-white font-semibold text-sm tracking-wide">Analsteroid</span>
            )}
            <button
              onClick={() => setCollapsed(v => !v)}
              className="text-[var(--color-sidebar-text)] hover:text-white p-1 rounded"
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
