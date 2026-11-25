// «Большой брат» — загрузки и экспорт отчётов как mono_action (доработка 26.11: «кто какие отчёты смотрит и насколько активно»).
// Отчёт определяется по Referer (страница, с которой пришёл запрос) — section = 'sales/<slug>' / 'sales/saved/<uuid>' /
// 'marketing/<preset>' / 'realizations/<x>' (lib/activity/section.ts). Запросы не со страницы отчёта (графики, презентация,
// фоновые прогоны) не пишутся. Одна запись на набор параметров: тот же человек + отчёт + действие + параметры
// за 2 мин — повтор, не пишем (in-memory, процесс один). Фильтры — только форма (сколько, какие ключи), без значений:
// в условиях «Фильтра сделок» бывают имена и телефоны.
import { createHash } from 'crypto';
import type { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/auth/session';
import { logActivity } from './log';
import { isReportSection, sectionOfPath } from './section';
import { ACTIVITY_SURFACES, type ActivitySurface } from './types';

const DEDUP_MS = 2 * 60_000;
const recent = new Map<string, number>();

function seenRecently(key: string): boolean {
  const now = Date.now();
  if (recent.size > 5000) for (const [k, t] of recent) if (now - t > DEDUP_MS) recent.delete(k);
  const t = recent.get(key);
  if (t && now - t < DEDUP_MS) return true;
  recent.set(key, now);
  return false;
}

function refererSection(req: NextRequest): string | null {
  const ref = req.headers.get('referer');
  if (!ref) return null;
  try { return sectionOfPath(new URL(ref).pathname); } catch { return null; }
}

const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const s = (v: unknown, max = 40) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

type LoadExtra = { durationMs?: number; rows?: number; error?: { status: number; message?: string } };

const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[\w.:-]{1,80}$/.test(x)).slice(0, 100) : undefined);

/** POST /api/reports/run и /api/reports/by-periods — после расчёта (успех: duration_ms, rows; сбой — report_error). Не бросает. */
export async function logReportRequest(session: SessionUser, req: NextRequest, body: Record<string, unknown> | null, extra: LoadExtra = {}): Promise<void> {
  try {
    const section = refererSection(req);
    if (!section || !isReportSection(section) || !body) return;
    const drill = body.managerId != null ? 'manager' : body.productGroupId != null ? 'product_group'
      : body.sourceFilter != null ? 'source' : body.teamId != null ? 'team' : null;
    const period = body.period as { from?: unknown; to?: unknown } | undefined;
    const comp = body.comparisonPeriod as { from?: unknown; to?: unknown } | undefined;
    const batch = body.batch as { size?: unknown } | null | undefined;
    const payload: Record<string, unknown> = {
      report_slug: s(body.reportSlug) ?? 'by-managers',
      period: { from: s(period?.from), to: s(period?.to) },
      comparison: { from: s(comp?.from), to: s(comp?.to) },
      deal_scope: s(body.dealScope), client_type: s(body.clientType), grouping: s(body.grouping),
      account_type: s(body.accountType), product_group_mode: s(body.productGroupMode),
      source_dimension: s(body.sourceDimension), unit: s(body.unit), dimension: s(body.dimension), compare_mode: s(body.compareMode),
      metrics: len(body.metricIds), departments: len(body.departmentIds), product_groups: len(body.productGroupIds),
      deal_filters: len(body.dealFilters),
      deal_filter_fields: Array.isArray(body.dealFilters)
        ? [...new Set(body.dealFilters.map(f => s((f as { field?: unknown })?.field, 60)).filter(Boolean))].slice(0, 20) : undefined,
      created_time: s(body.createdTimeFilter), first_touch: s(body.firstTouchFilter),
      batch: batch ? Number(batch.size) || true : undefined,
      split_by_team: body.splitByTeam === true || undefined,
      drill: drill ?? undefined,
      // Дрилл в менеджера / отдел — id сотрудника и отдела (не ПДн клиентов); читает поток B (матрица «РОП × менеджеры»).
      manager_id: body.managerId != null && /^\d{1,15}$/.test(String(body.managerId)) ? String(body.managerId) : undefined,
      team_id: body.teamId != null && /^[0-9a-zA-Z-]{1,40}$/.test(String(body.teamId)) ? String(body.teamId) : undefined,
      metric_ids: ids(body.metricIds),
    };
    const action = extra.error ? 'report_error' : drill ? 'report_drill' : 'report_load';
    const hash = createHash('sha1').update(JSON.stringify({ ...payload, drillKey: drill ? [body.managerId, body.productGroupId, body.sourceFilter, body.teamId] : null })).digest('hex');
    if (seenRecently(`${session.id}|${section}|${action}|${hash}`)) return;
    await logActivity(session, {
      kind: 'mono_action', section, action, entityType: 'report', entityId: section,
      payload: {
        ...payload,
        ...(extra.durationMs != null ? { duration_ms: Math.round(extra.durationMs) } : {}),
        ...(extra.rows != null ? { rows: extra.rows } : {}),
        ...(extra.error ? { error_status: extra.error.status, error: extra.error.message?.slice(0, 200) } : {}),
      },
    });
  } catch (err) {
    console.warn('[activity] report_load не записалось:', err instanceof Error ? err.message : err);
  }
}

/** Обёртка роута расчёта отчёта: сбой (исключение или ответ ≥ 500) → отдельная запись report_error с длительностью.
 *  Успех пишет сам роут (logReportRequest с duration_ms/rows) — там известны строки. */
export async function withReportErrorLog(req: NextRequest, handle: (req: NextRequest) => Promise<Response>): Promise<Response> {
  const t0 = Date.now();
  const copy = req.clone();
  const fail = async (status: number, message?: string) => {
    try {
      const { getSession } = await import('@/lib/auth/session');
      const session = await getSession();
      if (!session) return;
      const body = await copy.json().catch(() => null) as Record<string, unknown> | null;
      await logReportRequest(session, req, body, { durationMs: Date.now() - t0, error: { status, message } });
    } catch { /* журнал не мешает ответу */ }
  };
  try {
    const res = await handle(req);
    if (res.status >= 500) void fail(res.status);
    return res;
  } catch (e) {
    void fail(500, e instanceof Error ? e.name : 'Error'); // только класс ошибки: в тексте бывают значения фильтров
    throw e;
  }
}

const FORMATS = ['copy', 'xlsx', 'pdf', 'png', 'csv'];
const rowsOf = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : undefined; };

/** POST /api/activity/event { action: 'report_export', path, format, rows?, surface } — экспорт отчёта делается в браузере. */
export async function logReportExport(session: SessionUser, b: { path?: unknown; format?: unknown; rows?: unknown; surface?: unknown }): Promise<void> {
  const section = typeof b.path === 'string' ? sectionOfPath(b.path.slice(0, 300)) : null;
  if (!section || !isReportSection(section)) return;
  const format = FORMATS.includes(String(b.format)) ? String(b.format) : 'other';
  if (seenRecently(`${session.id}|${section}|report_export|${format}`)) return;
  const surface = ACTIVITY_SURFACES.includes(b.surface as ActivitySurface) ? b.surface as ActivitySurface : 'web';
  const rows = rowsOf(b.rows);
  await logActivity(session, {
    kind: 'mono_action', section, action: 'report_export', surface, entityType: 'report', entityId: section,
    payload: { format, ...(rows != null ? { rows } : {}) },
  });
}

/** POST /api/activity/event { action: 'export', what, format, rows?, path } — выгрузки вне отчётов (планы, маркетинг, ссылки). */
export async function logExport(session: SessionUser, b: { path?: unknown; what?: unknown; format?: unknown; rows?: unknown; surface?: unknown }): Promise<void> {
  const section = typeof b.path === 'string' ? sectionOfPath(b.path.slice(0, 300)) : 'unknown';
  const what = typeof b.what === 'string' && /^[a-z0-9_]{1,40}$/.test(b.what) ? b.what : 'other';
  const format = FORMATS.includes(String(b.format)) ? String(b.format) : 'other';
  if (seenRecently(`${session.id}|${section}|export|${what}|${format}`)) return;
  const surface = ACTIVITY_SURFACES.includes(b.surface as ActivitySurface) ? b.surface as ActivitySurface : 'web';
  const rows = rowsOf(b.rows);
  await logActivity(session, {
    kind: 'mono_action', section, action: 'export', surface, entityType: what,
    payload: { what, format, ...(rows != null ? { rows } : {}) },
  });
}
