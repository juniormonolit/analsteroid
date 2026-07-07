// Превью и ручная отправка ежедневного отчёта «МОСКВА» (бот «Аналитик»).
// GET  ?date=YYYY-MM-DD — собрать текст отчёта без отправки (по умолчанию за сегодня).
// POST { date?, dialogId? } — собрать и отправить (по умолчанию получателю из env).

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildDailyMoscowReport, sendDailyMoscowReport } from '@/lib/jobs/dailyMoscowReport';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const date = req.nextUrl.searchParams.get('date') || undefined;
  if (date && !DATE_RE.test(date)) return NextResponse.json({ error: 'date: ожидается YYYY-MM-DD' }, { status: 400 });

  try {
    const report = await buildDailyMoscowReport(date);
    return NextResponse.json(report);
  } catch (e) {
    console.error('[daily-report] build failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка сборки отчёта' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const date = typeof body.date === 'string' ? body.date : undefined;
  const dialogId = typeof body.dialogId === 'string' ? body.dialogId : undefined;
  if (date && !DATE_RE.test(date)) return NextResponse.json({ error: 'date: ожидается YYYY-MM-DD' }, { status: 400 });

  try {
    const report = await sendDailyMoscowReport(dialogId, date);
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    console.error('[daily-report] send failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка отправки отчёта' }, { status: 500 });
  }
}
