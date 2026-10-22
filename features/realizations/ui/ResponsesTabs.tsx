'use client';
// Лента вкладок «Ответы на запросы»: Снабженцы · Категории · Товары · Доля запросов.
// Четыре вкладки — flex-wrap (перенос на новую строку), а не горизонтальный скролл:
// этот класс багов (правило 12 CLAUDE.md) снят структурно, как в TabBar настроек наград.
// Вкладки — ссылки (у каждой свой адрес), активная — по pathname.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/realizations/responses', label: 'Снабженцы' },
  { href: '/realizations/responses/categories', label: 'Категории' },
  { href: '/realizations/responses/goods', label: 'Товары' },
  { href: '/realizations/responses/share', label: 'Доля запросов' },
] as const;

export function ResponsesTabs() {
  const pathname = usePathname().replace(/\/$/, '');
  // Сторож методики (lib/supplyPanel/version.ts): код панели новее нашего порта — цифры могут разойтись.
  const [methodChanged, setMethodChanged] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/realizations/supply/meta').then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d?.methodChanged) setMethodChanged(true); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return (
    <>
    <nav aria-label="Разделы отчёта" className="shrink-0 flex flex-wrap gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3 sm:px-6">
      {TABS.map(t => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
            className={`focus-ring inline-flex min-h-11 sm:min-h-0 items-center px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              active
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
    {methodChanged && (
      <div role="status" className="shrink-0 mx-3 sm:mx-6 mt-2 flex items-start gap-2 rounded-lg border border-[var(--warning-text)]/30 bg-[var(--warning-bg)] px-3 py-2 text-[13px] text-[var(--color-text)]">
        <AlertTriangle size={16} className="mt-px shrink-0 text-[var(--warning-text)]" aria-hidden />
        <span>Методика Панели снабжения обновилась, а расчёт здесь — ещё по прежней версии. Цифры могут расходиться с панелью, пока правки не перенесены.</span>
      </div>
    )}
    </>
  );
}
