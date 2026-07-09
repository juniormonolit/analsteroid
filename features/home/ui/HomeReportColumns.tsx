'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { SavedReport } from '@/lib/saved-reports/types';

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

// Правка по фидбеку владельца: пастельные квадратики с иконками убраны —
// строка списка это просто название + приглушённая подпись, без картинок.
function Row({ href, title, subtitle }: { href: string; title: string; subtitle?: string }) {
  return (
    <Link
      href={href}
      className="group block px-3 py-2 my-0.5 rounded-[9px] text-left transition-colors hover:bg-[var(--color-table-row-hover)]"
    >
      <span className="block text-sm font-medium text-[var(--color-text)] truncate group-hover:text-[#1a3f9e]">
        {title}
      </span>
      {subtitle && (
        <span className="block text-[11.5px] text-[#a6acb8] truncate">{subtitle}</span>
      )}
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
          href="/sales/by-managers"
          title="По менеджерам" subtitle="Выручка и динамика по менеджерам"
        />
        <Row
          href="/sales/by-product-groups"
          title="По товарным группам" subtitle="Показатели по категориям товаров"
        />
        {ropMonitorShared.map(r => (
          <Row
            key={r.id} href={`/sales/saved/${r.id}`}
            title={r.name} subtitle={slugLabel(r.reportSlug)}
          />
        ))}
      </div>

      {/* Смекалочная */}
      <div>
        <ColumnEyebrow>Отчёты Стаса</ColumnEyebrow>
        {!isLoading && smekalochnayaShared.length === 0 && (
          <div className="text-[13px] text-[var(--color-text-muted)] py-1 px-1">Пока нет общих отчётов</div>
        )}
        {smekalochnayaShared.map(r => (
          <Row
            key={r.id} href={`/sales/saved/${r.id}`}
            title={r.name} subtitle={slugLabel(r.reportSlug)}
          />
        ))}
      </div>

      {/* Избранное */}
      <div>
        <ColumnEyebrow>Избранное</ColumnEyebrow>
        {ownReports.map(r => (
          <Row
            key={r.id} href={`/sales/saved/${r.id}`}
            title={r.name} subtitle={`Сохранённый фильтр · ${slugLabel(r.reportSlug)}`}
          />
        ))}
        {!isLoading && ownReports.length === 0 && (
          <div className="border border-dashed border-[#dfe2e8] rounded-[10px] bg-[var(--color-bg)] px-3.5 py-4 mt-0.5">
            <div className="text-[13.5px] font-semibold text-[var(--color-text-muted)] mb-1">
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
