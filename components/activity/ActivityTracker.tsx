'use client';
// «Большой брат» — клиентский трекер активности Монолитики (ТЗ BIG_BROTHER_SPEC.md, «Heartbeat Монолитики»).
//  • page view — при смене маршрута (копится в очередь, уходит пачкой с задержкой 3 с или с ближайшим пульсом);
//  • heartbeat — раз в 60 с, ТОЛЬКО если вкладка видима и был ввод за последние 2 мин
//    (pointermove/pointerdown/keydown/wheel/touchstart внутри документа — в iframe Битрикса это и есть ввод внутри фрейма);
//  • surface — из useAppMode() (CLAUDE.md, правило 11), читается в момент отправки (после гидрации режим уточняется).
// Один запрос в минуту максимум + редкие пачки просмотров; при уходе со страницы — sendBeacon.
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useAppMode, type AppMode } from '@/lib/hooks/useAppMode';
import type { ActivitySurface } from '@/lib/activity/types';

const BEAT_MS = 60_000;
const IDLE_MS = 120_000;
const VIEW_FLUSH_MS = 3_000;

const SURFACE: Record<AppMode, ActivitySurface> = {
  desktop: 'web', mobile: 'mobile', standalone: 'pwa', 'bitrix-iframe': 'bx_iframe',
};

type View = { path: string; at: number };

function send(body: object, beacon = false) {
  const json = JSON.stringify(body);
  try {
    if (beacon && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/activity/beat', new Blob([json], { type: 'application/json' }));
      return;
    }
    void fetch('/api/activity/beat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true, credentials: 'same-origin',
    }).catch(() => {});
  } catch { /* журнал не должен мешать работе */ }
}

export function ActivityTracker() {
  const pathname = usePathname();
  const { mode } = useAppMode();
  const modeRef = useRef(mode);
  const pathRef = useRef(pathname);
  useEffect(() => { modeRef.current = mode; pathRef.current = pathname; }, [mode, pathname]);
  const queue = useRef<View[]>([]);
  const lastInput = useRef(Date.now());
  const lastPath = useRef<string | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useRef((active: boolean, beacon = false) => {
    const views = queue.current.splice(0, queue.current.length);
    if (!active && !views.length) return;
    send({ surface: SURFACE[modeRef.current], path: pathRef.current, active, views }, beacon);
  });

  // просмотр раздела
  useEffect(() => {
    if (!pathname || pathname === lastPath.current) return;
    lastPath.current = pathname;
    queue.current.push({ path: pathname, at: Date.now() });
    if (queue.current.length > 20) queue.current.shift();
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flush.current(false), VIEW_FLUSH_MS);
  }, [pathname]);

  // ввод + пульс
  useEffect(() => {
    const onInput = () => { lastInput.current = Date.now(); };
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach(e => window.addEventListener(e, onInput, { passive: true, capture: true }));
    const tick = setInterval(() => {
      const active = document.visibilityState === 'visible' && Date.now() - lastInput.current < IDLE_MS;
      if (active && flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
      flush.current(active);
    }, BEAT_MS);
    const onHide = () => { if (queue.current.length) flush.current(false, true); };
    window.addEventListener('pagehide', onHide);
    return () => {
      evs.forEach(e => window.removeEventListener(e, onInput, { capture: true }));
      window.removeEventListener('pagehide', onHide);
      clearInterval(tick);
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, []);

  return null;
}
