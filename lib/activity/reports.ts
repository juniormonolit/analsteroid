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

/** POST /api/reports/run и /api/reports/by-periods — после успешного расчёта. Не бросает. */
export async function logReportRequest(session: SessionUser, req: NextRequest, body: Record<string, unknown> | null): Promise<void> {
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
    };
    const action = drill ? 'report_drill' : 'report_load';
    const hash = createHash('sha1').update(JSON.stringify({ ...payload, drillKey: drill ? [body.managerId, body.productGroupId, body.sourceFilter, body.teamId] : null })).digest('hex');
    if (seenRecently(`${session.id}|${section}|${action}|${hash}`)) return;
    await logActivity(session, { kind: 'mono_action', section, action, entityType: 'report', entityId: section, payload });
  } catch (err) {
    console.warn('[activity] report_load не записалось:', err instanceof Error ? err.message : err);
  }
}

/** POST /api/activity/event { action: 'report_export', path, format, surface } — экспорт делается в браузере. */
export async function logReportExport(session: SessionUser, b: { path?: unknown; format?: unknown; surface?: unknown }): Promise<void> {
  const section = typeof b.path === 'string' ? sectionOfPath(b.path.slice(0, 300)) : null;
  if (!section || !isReportSection(section)) return;
  const format = ['copy', 'xlsx', 'pdf', 'png'].includes(String(b.format)) ? String(b.format) : 'other';
  if (seenRecently(`${session.id}|${section}|report_export|${format}`)) return;
  const surface = ACTIVITY_SURFACES.includes(b.surface as ActivitySurface) ? b.surface as ActivitySurface : 'web';
  await logActivity(session, { kind: 'mono_action', section, action: 'report_export', surface, entityType: 'report', entityId: section, payload: { format } });
}
