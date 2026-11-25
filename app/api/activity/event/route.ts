// «Большой брат» — события, которые случаются только в браузере: экспорт отчёта (report_export) и прочие выгрузки (export).
// Белый список действий; всегда 204.
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { logExport, logReportExport } from '@/lib/activity/reports';
import { logActivity } from '@/lib/activity/log';
import { sectionOfPath } from '@/lib/activity/section';
import { ACTIVITY_SURFACES, type ActivitySurface } from '@/lib/activity/types';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 204 });
  const b = await req.json().catch(() => null) as { action?: unknown; path?: unknown; what?: unknown; format?: unknown; rows?: unknown; surface?: unknown } | null;
  if (b?.action === 'report_export') await logReportExport(session, b);
  else if (b?.action === 'export') await logExport(session, b);
  else if (b?.action === 'changelog_open') {
    const unread = Number(b.rows);
    await logActivity(session, {
      kind: 'mono_action', section: 'changelog', action: 'changelog_open',
      surface: ACTIVITY_SURFACES.includes(b.surface as ActivitySurface) ? b.surface as ActivitySurface : 'web',
      payload: { ...(Number.isInteger(unread) && unread >= 0 ? { unread } : {}),
        ...(typeof b.path === 'string' ? { from: sectionOfPath(b.path.slice(0, 300)) } : {}) },
    });
  }
  return new NextResponse(null, { status: 204 });
}
