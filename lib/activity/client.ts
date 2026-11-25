'use client';
// «Большой брат» — клиентские события вне трекера (выгрузки: всё собирается в браузере или скачивается файлом).
// Режим запуска (surface) кладёт сюда ActivityTracker из useAppMode() — свою проверку режима здесь не делаем
// (CLAUDE.md, правило 11). Только форма события: что выгружено, формат, число строк — без содержимого. Не бросает.
import type { ActivitySurface } from './types';

let surface: ActivitySurface = 'web';
export function setActivitySurface(s: ActivitySurface) { surface = s; }

function post(body: Record<string, unknown>) {
  try {
    void fetch('/api/activity/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, credentials: 'same-origin',
      body: JSON.stringify({ ...body, path: window.location.pathname, surface }),
    }).catch(() => {});
  } catch { /* журнал не мешает выгрузке */ }
}

/** Выгрузка/копирование. what — что выгружено ('report' | 'plans_template' | 'marketing_structure' | 'deal_link' | …),
 *  format — copy | xlsx | pdf | png | csv, rows — сколько строк ушло (если известно). */
export function trackExport(what: string, format: string, rows?: number | null) {
  post({ action: 'export', what, format, ...(rows != null ? { rows } : {}) });
}

/** Экспорт отчёта из ExportMenu (section — отчёт по адресу страницы). */
export function trackReportExport(format: string, rows?: number | null) {
  post({ action: 'report_export', format, ...(rows != null ? { rows } : {}) });
}

/** Открыта панель «Что изменилось?» (сколько было непрочитанных записей). */
export function trackChangelogOpen(unread?: number | null) {
  post({ action: 'changelog_open', ...(unread != null ? { rows: unread } : {}) });
}
