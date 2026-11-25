'use client';
// «Большой брат» — клиентский трекер активности Монолитики (ТЗ BIG_BROTHER_SPEC.md, «Heartbeat Монолитики»).
//  • page view — при смене маршрута (копится в очередь, уходит пачкой с задержкой 3 с или с ближайшим пульсом);
//  • heartbeat — раз в 60 с, ТОЛЬКО если вкладка видима и был ввод за последние 2 мин
//    (pointermove/pointerdown/keydown/wheel/touchstart внутри документа — в iframe Битрикса это и есть ввод внутри фрейма);
//  • surface — из useAppMode() (CLAUDE.md, правило 11), читается в момент отправки (после гидрации режим уточняется).
// Один запрос в минуту максимум + редкие пачки просмотров; при уходе со страницы — sendBeacon.
// Доработка 26.11 (пакет сбора данных): просмотр = путь + белый список query (lib/activity/viewQuery.ts: tab, customer,
// client, deal, view; src/m — только у первого просмотра загрузки, это переход из сообщения бота) + prev — откуда пришёл;
// при уходе со страницы (смена маршрута / pagehide) — leave с active_ms (видимая вкладка + ввод за 2 мин) и total_ms.
import { Suspense, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { safeQuery } from '@/lib/activity/viewQuery';
import { useAppMode, type AppMode } from '@/lib/hooks/useAppMode';
import type { ActivitySurface } from '@/lib/activity/types';
import { setActivitySurface } from '@/lib/activity/client';

const BEAT_MS = 60_000;
const IDLE_MS = 120_000;
const VIEW_FLUSH_MS = 3_000;
const ACTIVE_TICK_MS = 5_000;

const SURFACE: Record<AppMode, ActivitySurface> = {
  desktop: 'web', mobile: 'mobile', standalone: 'pwa', 'bitrix-iframe': 'bx_iframe',
};

type View = { path: string; query: Record<string, string>; prev: string | null; at: number };
type Leave = { path: string; query: Record<string, string>; active_ms: number; total_ms: number };

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

/** useSearchParams требует Suspense-границы — трекер её даёт сам, AppShell подключает одной строкой. */
export function ActivityTracker() {
  return <Suspense fallback={null}><Tracker /></Suspense>;
}

function Tracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const { mode } = useAppMode();
  const modeRef = useRef(mode);
  const pathRef = useRef(pathname);
  useEffect(() => { modeRef.current = mode; pathRef.current = pathname; setActivitySurface(SURFACE[mode]); }, [mode, pathname]);
  const queue = useRef<View[]>([]);
  const leaves = useRef<Leave[]>([]);
  const lastInput = useRef(Date.now());
  const current = useRef<{ key: string; path: string; query: Record<string, string>; since: number; activeMs: number } | null>(null);
  const firstView = useRef(true);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useRef((active: boolean, beacon = false) => {
    const views = queue.current.splice(0, queue.current.length);
    const left = leaves.current.splice(0, leaves.current.length);
    if (!active && !views.length && !left.length) return;
    send({ surface: SURFACE[modeRef.current], path: pathRef.current, active, views, leaves: left }, beacon);
  });

  const closeCurrent = useRef(() => {
    const c = current.current;
    if (!c) return;
    leaves.current.push({ path: c.path, query: c.query, active_ms: c.activeMs, total_ms: Date.now() - c.since });
    if (leaves.current.length > 20) leaves.current.shift();
    current.current = null;
  });

  // просмотр страницы (путь + безопасный query)
  useEffect(() => {
    if (!pathname) return;
    const all = safeQuery(search);
    const { src, m, ...rest } = all;
    const query = firstView.current && src ? { ...rest, src, ...(m ? { m } : {}) } : rest;
    const key = `${pathname}?${new URLSearchParams(rest).toString()}`;
    if (current.current?.key === key) return;
    const prev = current.current?.path ?? null;
    closeCurrent.current();
    firstView.current = false;
    current.current = { key, path: pathname, query: rest, since: Date.now(), activeMs: 0 };
    queue.current.push({ path: pathname, query, prev, at: Date.now() });
    if (queue.current.length > 20) queue.current.shift();
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flush.current(false), VIEW_FLUSH_MS);
  }, [pathname, search]);

  // ввод + активное время страницы + пульс
  useEffect(() => {
    const onInput = () => { lastInput.current = Date.now(); };
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach(e => window.addEventListener(e, onInput, { passive: true, capture: true }));
    const isActive = () => document.visibilityState === 'visible' && Date.now() - lastInput.current < IDLE_MS;
    const activeTick = setInterval(() => { if (current.current && isActive()) current.current.activeMs += ACTIVE_TICK_MS; }, ACTIVE_TICK_MS);
    const tick = setInterval(() => {
      const active = isActive();
      if (active && flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
      flush.current(active);
    }, BEAT_MS);
    const onHide = () => {
      closeCurrent.current();
      flush.current(false, true);
    };
    // Вернулись на ту же вкладку из bfcache — продолжаем отсчёт той же страницы как нового просмотра.
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      const path = window.location.pathname;
      const query = safeQuery(window.location.search);
      delete query.src; delete query.m;
      current.current = { key: `${path}?${new URLSearchParams(query).toString()}`, path, query, since: Date.now(), activeMs: 0 };
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      evs.forEach(e => window.removeEventListener(e, onInput, { capture: true }));
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      clearInterval(tick);
      clearInterval(activeTick);
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, []);

  return null;
}
