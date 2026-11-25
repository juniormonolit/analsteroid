// «Большой брат» — приём пульса и просмотров от components/activity/ActivityTracker.tsx.
// active=true → 5-мин бакет в activity_minutes (ON CONFLICT DO NOTHING, повтор в бакете — no-op);
// views[]   → mono_view (≤ 10 за запрос; путь + безопасный query, prev, сущность); leaves[] → active_ms/total_ms в последний view.
// Всегда 204: трекер ответ не читает, ошибки журнала не должны сыпаться в консоль пользователя.
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { logActivity, recordMinute, recordViewLeave } from '@/lib/activity/log';
import { safeQuery, viewEntity } from '@/lib/activity/viewQuery';
import { ACTIVITY_SURFACES, type ActivitySurface } from '@/lib/activity/types';
import { sectionOfPath } from '@/lib/activity/section';

const ok = () => new NextResponse(null, { status: 204 });

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return ok();
  let body: { surface?: unknown; path?: unknown; active?: unknown; views?: unknown; leaves?: unknown };
  try { body = await req.json(); } catch { return ok(); }

  const surface: ActivitySurface = ACTIVITY_SURFACES.includes(body.surface as ActivitySurface)
    ? body.surface as ActivitySurface : 'web';
  const path = typeof body.path === 'string' ? body.path.slice(0, 300) : '/';

  const jobs: Promise<unknown>[] = [];
  if (body.active === true) {
    jobs.push(recordMinute(session, { surface, section: sectionOfPath(path) }));
  }
  // Сначала просмотры (по порядку — leave в той же пачке должен найти свою строку), потом длительности.
  if (Array.isArray(body.views)) {
    let prevKey = '';
    const now = Date.now();
    for (const v of body.views.slice(-10)) {
      const p = typeof v?.path === 'string' ? v.path.slice(0, 300) : null;
      if (!p) continue;
      const query = safeQuery(v?.query as Record<string, unknown> | undefined);
      const key = `${p}?${JSON.stringify(query)}`;
      if (key === prevKey) continue;
      prevKey = key;
      const at = Number(v.at);
      // время клиента — только если правдоподобно (последние 10 мин), иначе серверное
      const ts = Number.isFinite(at) && at <= now + 60_000 && at > now - 600_000 ? new Date(at).toISOString() : undefined;
      const prev = typeof v?.prev === 'string' && v.prev.startsWith('/') ? sectionOfPath(v.prev.slice(0, 300)) : null;
      const ent = viewEntity(p, query);
      await logActivity(session, {
        kind: 'mono_view', section: sectionOfPath(p), surface,
        entityType: ent?.entityType ?? null, entityId: ent?.entityId ?? null, dealId: ent?.dealId ?? null,
        payload: {
          path: p, ...(Object.keys(query).length ? { query } : {}), ...(prev ? { prev } : {}), ...(ts ? { client_ts: ts } : {}),
          ...(query.src ? { src: query.src } : {}), ...(query.m ? { m: query.m } : {}),
        },
      });
    }
  }
  if (Array.isArray(body.leaves)) {
    for (const l of body.leaves.slice(-10)) {
      const p = typeof l?.path === 'string' ? l.path.slice(0, 300) : null;
      const activeMs = Math.round(Number(l?.active_ms));
      const totalMs = Math.round(Number(l?.total_ms));
      if (!p || !Number.isFinite(activeMs) || !Number.isFinite(totalMs) || totalMs < 0) continue;
      jobs.push(recordViewLeave(session, p, Math.max(0, Math.min(activeMs, totalMs)), Math.min(totalMs, 7 * 86_400_000)));
    }
  }
  await Promise.all(jobs);
  return ok();
}
