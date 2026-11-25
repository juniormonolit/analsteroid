// «Большой брат» — приём пульса и просмотров от components/activity/ActivityTracker.tsx.
// active=true → 5-мин бакет в activity_minutes (ON CONFLICT DO NOTHING, повтор в бакете — no-op);
// views[]   → mono_view в activity_events (не больше 10 за запрос, подряд одинаковые разделы схлопываются).
// Всегда 204: трекер ответ не читает, ошибки журнала не должны сыпаться в консоль пользователя.
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { logActivity, recordMinute } from '@/lib/activity/log';
import { ACTIVITY_SURFACES, type ActivitySurface } from '@/lib/activity/types';
import { sectionOfPath } from '@/lib/activity/section';

const ok = () => new NextResponse(null, { status: 204 });

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return ok();
  let body: { surface?: unknown; path?: unknown; active?: unknown; views?: unknown };
  try { body = await req.json(); } catch { return ok(); }

  const surface: ActivitySurface = ACTIVITY_SURFACES.includes(body.surface as ActivitySurface)
    ? body.surface as ActivitySurface : 'web';
  const path = typeof body.path === 'string' ? body.path.slice(0, 300) : '/';

  const jobs: Promise<unknown>[] = [];
  if (body.active === true) {
    jobs.push(recordMinute(session, { surface, section: sectionOfPath(path) }));
  }
  if (Array.isArray(body.views)) {
    let prev = '';
    const now = Date.now();
    for (const v of body.views.slice(-10)) {
      const p = typeof v?.path === 'string' ? v.path.slice(0, 300) : null;
      if (!p) continue;
      const section = sectionOfPath(p);
      if (section === prev) continue;
      prev = section;
      const at = Number(v.at);
      // время клиента — только если правдоподобно (последние 10 мин), иначе серверное
      const ts = Number.isFinite(at) && at <= now + 60_000 && at > now - 600_000 ? new Date(at).toISOString() : undefined;
      jobs.push(logActivity(session, { kind: 'mono_view', section, surface, payload: { path: p, ...(ts ? { client_ts: ts } : {}) } }));
    }
  }
  await Promise.all(jobs);
  return ok();
}
