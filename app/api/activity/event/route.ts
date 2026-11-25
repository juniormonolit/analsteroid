// «Большой брат» — события, которые случаются только в браузере (экспорт отчёта: Excel/PDF/PNG/буфер собираются на клиенте).
// Белый список действий; всегда 204.
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { logReportExport } from '@/lib/activity/reports';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 204 });
  const b = await req.json().catch(() => null) as { action?: unknown; path?: unknown; format?: unknown; surface?: unknown } | null;
  if (b?.action === 'report_export') await logReportExport(session, b);
  return new NextResponse(null, { status: 204 });
}
