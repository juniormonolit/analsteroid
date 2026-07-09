'use client';
import type { ComponentType } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Users, Package, BarChart3, Star,
  Calendar, Filter, TrendingUp, PieChart, DollarSign, Clock, UserCheck,
} from 'lucide-react';
import type { SavedReport } from '@/lib/saved-reports/types';

type IconCmp = ComponentType<{ size?: number; className?: string }>;

// Дружественная подпись типа отчёта под именем сохранённого/общего отчёта —
// подпись генерится из report_slug (данных о содержимом самого фильтра на
// сервере нет), см. бриф Главной. Расширять по мере появления новых типов.
const REPORT_SLUG_LABEL: Record<string, string> = {
  'by-managers': 'По менеджерам',
  'by-product-groups': 'По товарным группам',
};
function slugLabel(slug: string): string {
  return REPORT_SLUG_LABEL[slug] ?? slug;
}

// Палитра «иконка + пастельный квадрат» для карточек «Смекалочная»/доп.
// «Роп монитор» — 1:1 с цветами утверждённого макета (analsteroid-home-mock.html,
// .icon-*). Реальные общие/личные отчёты не несут метаданных о типе виджета,
// поэтому иконка/цвет циклятся по индексу — так же, как в самом макете
// повторяются amber/blue/violet/teal на разных строках.
const PALETTE: { icon: IconCmp; bg: string; fg: string }[] = [
  { icon: Calendar, bg: '#fef6e7', fg: '#c68a1a' },
  { icon: Filter, bg: '#fdeef1', fg: '#d1447a' },
  { icon: Package, bg: '#eaf6fd', fg: '#1892c9' },
  { icon: TrendingUp, bg: '#eef2ff', fg: '#3b62e0' },
  { icon: PieChart, bg: '#f2eefc', fg: '#7c4fd6' },
  { icon: DollarSign, bg: '#e8f8f4', fg: '#12a583' },
  { icon: Clock, bg: '#fef6e7', fg: '#c68a1a' },
  { icon: UserCheck, bg: '#f2f3f5', fg: '#8a919e' },
];

function Row({ href, icon: Icon, bg, fg, title, subtitle }: {
  href: string; icon: IconCmp; bg: string; fg: string; title: string; subtitle?: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-2.5 px-3 py-2 my-0.5 rounded-[9px] transition-colors hover:bg-[var(--color-table-row-hover)]"
    >
      <span
        className="w-7 h-7 rounded-[7px] flex items-center justify-center shrink-0"
        style={{ backgroundColor: bg, color: fg }}
      >
        <Icon size={15} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--color-text)] truncate group-hover:text-[#1a3f9e]">
          {title}
        </span>
        {subtitle && (
          <span className="block text-[11.5px] text-[#a6acb8] truncate">{subtitle}</span>
        )}
      </span>
    </Link>
  );
}

function ColumnEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-[#a6acb8] pb-2.5 mb-2 border-b border-[var(--color-border)]">
      {children}
    </div>
  );
}

/*
 * Три колонки Главной: «Роп монитор · Продажи» (стандартные отчёты +
 * общие отчёты витрины rop_monitor), «Смекалочная» (общие отчёты витрины
 * smekalochnaya), «Избранное» (личные сохранённые отчёты юзера). Один и тот
 * же источник данных и фильтрация, что в сайдбаре (components/layout/AppShell.tsx
 * SalesSidebarSection) — те же react-query key и is_shared/shared_section/
 * user_login признаки, поэтому кеш переиспользуется, новых эндпоинтов нет.
 *
 * Права: весь блок целиком завязан на section.sales — сайдбар прячет
 * Роп монитор/Смекалочную/Избранное внутри пункта «Продажи», и прямые ссылки
 * /sales/saved/[id] всё равно редиректят без этого права (app/(app)/sales/layout.tsx).
 * Без section.sales колонки не рендерим вовсе, чтобы не показывать ссылки,
 * ведущие на редирект.
 */
export function HomeReportColumns({ canSales, userLogin }: { canSales: boolean; userLogin: string }) {
  const { data: savedReports = [], isLoading } = useQuery<SavedReport[]>({
    queryKey: ['saved-reports'],
    queryFn: async () => {
      const res = await fetch('/api/saved-reports');
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 30_000,
    enabled: canSales,
  });

  if (!canSales) {
    return (
      <p className="text-sm text-[var(--color-text-muted)] mt-2 text-center">
        Отчёты пока не назначены — обратитесь к администратору.
      </p>
    );
  }

  const ropMonitorShared = savedReports.filter(r => r.isShared && r.sharedSection === 'rop_monitor');
  const smekalochnayaShared = savedReports.filter(r => r.isShared && r.sharedSection === 'smekalochnaya');
  const ownReports = savedReports.filter(r => !r.isShared && r.userLogin === userLogin);

  return (
    <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-11 items-start">
      {/* Роп монитор · Продажи */}
      <div>
        <ColumnEyebrow>Роп монитор · Продажи</ColumnEyebrow>
        <Row
          href="/sales/by-managers" icon={Users} bg="#eef2ff" fg="#3b62e0"
          title="По менеджерам" subtitle="Выручка и динамика по менеджерам"
        />
        <Row
          href="/sales/by-product-groups" icon={Package} bg="#f2eefc" fg="#7c4fd6"
          title="По товарным группам" subtitle="Показатели по категориям товаров"
        />
        {ropMonitorShared.map((r, i) => {
          const p = PALETTE[i % PALETTE.length];
          return (
            <Row
              key={r.id} href={`/sales/saved/${r.id}`} icon={BarChart3} bg={p.bg} fg={p.fg}
              title={r.name} subtitle={slugLabel(r.reportSlug)}
            />
          );
        })}
      </div>

      {/* Смекалочная */}
      <div>
        <ColumnEyebrow>Смекалочная</ColumnEyebrow>
        {!isLoading && smekalochnayaShared.length === 0 && (
          <div className="text-[13px] text-[var(--color-text-muted)] py-1 px-1">Пока нет общих отчётов</div>
        )}
        {smekalochnayaShared.map((r, i) => {
          const p = PALETTE[i % PALETTE.length];
          return (
            <Row
              key={r.id} href={`/sales/saved/${r.id}`} icon={p.icon} bg={p.bg} fg={p.fg}
              title={r.name} subtitle={slugLabel(r.reportSlug)}
            />
          );
        })}
      </div>

      {/* Избранное */}
      <div>
        <ColumnEyebrow>Избранное</ColumnEyebrow>
        {ownReports.map(r => (
          <Row
            key={r.id} href={`/sales/saved/${r.id}`} icon={Star} bg="#fef6e7" fg="#c68a1a"
            title={r.name} subtitle={`Сохранённый фильтр · ${slugLabel(r.reportSlug)}`}
          />
        ))}
        {!isLoading && ownReports.length === 0 && (
          <div className="border border-dashed border-[#dfe2e8] rounded-[10px] bg-[var(--color-bg)] px-3.5 py-4 mt-0.5">
            <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--color-text-muted)] mb-1">
              <Star size={14} className="text-[#b6bac2]" />
              Добавьте ещё
            </div>
            <div className="text-[11.5px] text-[#a6acb8] leading-relaxed">
              Отметьте отчёт звёздочкой — он появится здесь для быстрого доступа
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
