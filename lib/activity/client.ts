'use client';
// «Большой брат» — клиентские события вне трекера (экспорт отчёта). Режим запуска (surface) кладёт сюда ActivityTracker
// из useAppMode() — свою проверку режима здесь не делаем (CLAUDE.md, правило 11). Не бросает, ответ не ждёт.
import type { ActivitySurface } from './types';

let surface: ActivitySurface = 'web';
export function setActivitySurface(s: ActivitySurface) { surface = s; }

export function trackReportExport(format: string) {
  try {
    void fetch('/api/activity/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, credentials: 'same-origin',
      body: JSON.stringify({ action: 'report_export', format, path: window.location.pathname, surface }),
    }).catch(() => {});
  } catch { /* журнал не мешает экспорту */ }
}
