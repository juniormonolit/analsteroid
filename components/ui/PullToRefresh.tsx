'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppMode } from '@/lib/hooks/useAppMode';

/**
 * Pull-to-refresh (задача 2947, П2.11 плана мобильной готовности) — жест
 * «потянуть вниз, чтобы обновить» на мобильной ширине. Общий компонент, а
 * не разовая правка одной страницы — та же дисциплина, что useAppMode/
 * useUrlState (см. DESIGN_GUIDELINES.md): любая страница, которой нужен
 * этот жест, оборачивает СВОЙ существующий скролл-контейнер этим
 * компонентом (передавая ему те же классы), не пишет обработчик заново.
 *
 * ВАЖНО — что этот компонент НЕ делает (сознательно, по опыту багов PWA):
 * - Не трогает горизонтальный скролл вообще: жест «залипает» на вертикаль
 *   только если ПЕРВОЕ заметное движение пальца (>8px) было преимущественно
 *   вертикальным вниз; если преимущественно горизонтальным (таблица с
 *   scroll-x) — компонент сразу отпускает жест и НЕ вызывает
 *   preventDefault(), нативный горизонтальный скролл идёт как обычно.
 * - Не перехватывает обычный вертикальный скролл контента: тянуть можно
 *   ТОЛЬКО когда сам контейнер уже в самом верху (`scrollTop === 0`) —
 *   иначе это обычный свайп внутри списка, а не pull-to-refresh.
 * - preventDefault() на touchmove вызывается ТОЛЬКО после того, как жест
 *   уже признан вертикальным pull'ом (см. выше) — до этого момента браузер
 *   продолжает решать сам, это и есть «не ломать нативный скролл».
 *
 * Форвардит ref на сам скролл-контейнер (`useImperativeHandle` → реальный
 * DOM-узел) — нужен вызывающей стороне для восстановления позиции скролла
 * между вкладками (задача 2947, П2.12: `ManagerCardPage.tsx`/`RatingPage.tsx`
 * читают/пишут `scrollTop` этого узла напрямую, отдельно от жеста
 * pull-to-refresh, который занят своими собственными touch-обработчиками).
 */
export const PullToRefresh = forwardRef<HTMLDivElement, {
  onRefresh: () => Promise<unknown> | void;
  children: React.ReactNode;
  className?: string;
}>(function PullToRefresh({ onRefresh, children, className }, forwardedRef) {
  const { isMobileLayout } = useAppMode();
  const containerRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(forwardedRef, () => containerRef.current as HTMLDivElement, []);
  const [pullPx, setPullPx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const animating = pullPx === 0 && !refreshing ? false : true;

  // Мутабельное состояние жеста живёт в ref'ах — не в React state — иначе
  // каждый touchmove пересоздавал бы обработчики (state в deps useEffect)
  // и заодно читал бы устаревшие замыкания.
  const gesture = useRef<{
    active: boolean;
    locked: 'pull' | 'reject' | null;
    startX: number;
    startY: number;
    pull: number;
  }>({ active: false, locked: null, startX: 0, startY: 0, pull: 0 });
  const refreshingRef = useRef(false);

  const THRESHOLD = 64;
  const MAX_PULL = 100;
  const LOCK_DISTANCE = 8;

  useEffect(() => {
    // Только мобильная раскладка (useAppMode — единый источник правды, см.
    // DESIGN_GUIDELINES.md) — на десктопе (в т.ч. тачскрин-ноутбуки) жест не
    // навешивается вовсе, а не просто визуально прячется.
    if (!isMobileLayout) return;
    const el = containerRef.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      if (refreshingRef.current || el!.scrollTop > 0) {
        gesture.current.active = false;
        gesture.current.locked = null;
        return;
      }
      gesture.current.active = true;
      gesture.current.locked = null;
      gesture.current.startX = e.touches[0].clientX;
      gesture.current.startY = e.touches[0].clientY;
      gesture.current.pull = 0;
    }

    function onTouchMove(e: TouchEvent) {
      const g = gesture.current;
      if (!g.active) return;
      const dx = e.touches[0].clientX - g.startX;
      const dy = e.touches[0].clientY - g.startY;

      if (g.locked === null) {
        if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) return; // ждём, пока жест определится
        g.locked = (dy > 0 && dy > Math.abs(dx)) ? 'pull' : 'reject';
        if (g.locked === 'reject') { g.active = false; return; }
      }
      if (g.locked !== 'pull') return;

      if (el!.scrollTop > 0) { g.active = false; setPullPx(0); return; }
      if (dy <= 0) { g.pull = 0; setPullPx(0); return; }

      // Демпфирование — тянуть физически можно сколько угодно, визуально
      // ограничено MAX_PULL, с сопротивлением по мере приближения к пределу
      // (тот же приём, что нативный iOS rubber-band).
      const damped = Math.min(MAX_PULL, dy * 0.5);
      g.pull = damped;
      setPullPx(damped);
      e.preventDefault();
    }

    function onTouchEnd() {
      const g = gesture.current;
      if (!g.active || g.locked !== 'pull') { g.active = false; return; }
      g.active = false;
      if (g.pull >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPullPx(THRESHOLD);
        Promise.resolve(onRefresh())
          .catch(() => {})
          .finally(() => {
            refreshingRef.current = false;
            setRefreshing(false);
            setPullPx(0);
          });
      } else {
        setPullPx(0);
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onRefresh читается через замыкание при каждом монтировании эффекта; передавать стабильную ссылку (useCallback) на вызывающей стороне
  }, [isMobileLayout]);

  return (
    <div ref={containerRef} className={className}>
      <div
        className="flex items-center justify-center overflow-hidden md:hidden"
        style={{
          height: pullPx,
          transition: animating && pullPx === 0 ? 'height var(--anim-duration) var(--anim-ease)' : undefined,
        }}
        aria-hidden={pullPx === 0 && !refreshing}
      >
        <RefreshCw
          size={18}
          className={refreshing ? 'animate-spin text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}
          style={refreshing ? undefined : { transform: `rotate(${(pullPx / THRESHOLD) * 360}deg)`, opacity: Math.min(1, pullPx / THRESHOLD) }}
        />
      </div>
      {children}
    </div>
  );
});
