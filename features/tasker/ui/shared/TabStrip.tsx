'use client';
// Горизонтальная лента вкладок Задачника по правилу 12 CLAUDE.md (эталон — features/reports/ui/ReportTabsBar.tsx):
// min-w-0 у обёртки, .scrollbar-none, затухание у края ТОЛЬКО когда правда есть что скроллить (scrollLeft/scrollWidth),
// автоскролл активной вкладки (без анимации при монтировании, плавно при смене). Вкладки помечать data-tab-key.
import { useCallback, useEffect, useRef, useState } from 'react';

export function TabStrip({ activeKey, ariaLabel, role, className = '', innerClassName = '', fadeFrom = 'var(--color-bg)', children }: {
  activeKey: string;
  ariaLabel: string;
  role?: 'tablist';
  /** Обёртка (рамка, ширина). */
  className?: string;
  /** Сам скролл-контейнер (отступы, gap). */
  innerClassName?: string;
  /** Цвет, в который затухает край, — фон под лентой. */
  fadeFrom?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setFade({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
  }, [measure]);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`);
    if (active) {
      // Сдвигаем только саму ленту (scrollIntoView прокрутил бы и страницу по вертикали).
      const l = active.offsetLeft - el.offsetLeft;
      const r = l + active.offsetWidth;
      const target = l < el.scrollLeft ? l - 8 : r > el.scrollLeft + el.clientWidth ? r - el.clientWidth + 8 : null;
      if (target !== null) el.scrollTo({ left: target, behavior: first.current ? 'auto' : 'smooth' });
    }
    first.current = false;
    measure();
  }, [activeKey, measure]);

  return (
    <div className={`relative min-w-0 max-w-full ${className}`}>
      <div ref={ref} role={role} aria-label={ariaLabel} className={`scrollbar-none flex min-w-0 overflow-x-auto overflow-y-hidden ${innerClassName}`}>
        {children}
      </div>
      {fade.left && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 rounded-l-lg" style={{ background: `linear-gradient(to right, ${fadeFrom}, transparent)` }} />}
      {fade.right && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-lg" style={{ background: `linear-gradient(to left, ${fadeFrom}, transparent)` }} />}
    </div>
  );
}
