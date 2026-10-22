import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canManageRepeatKanbanSettings } from '@/lib/auth/modulesAccess';
import { buildMorningMessages } from '@/features/repeat-kanban/engine/morning';
import { systemDb } from '@/lib/db/clients';

// Утро менеджера по повторным (миграция 238) — для админов: ?preview=1 — собрать сообщения прямо
// сейчас, ничего не записывая и не отправляя; без него — журнал прогона за ?date= (по умолчанию сегодня).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageRepeatKanbanSettings(session)) return NextResponse.json({ error: 'Только администраторам' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  try {
    if (sp.get('preview') === '1') {
      const msgs = await buildMorningMessages();
      return NextResponse.json({ preview: true, count: msgs.length, messages: msgs }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('date') ?? '') ? sp.get('date')! : new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    const r = await systemDb().query(
      `SELECT manager_id, manager_name, message, items, sent, error, created_at FROM repeat_morning_log WHERE run_date = $1 ORDER BY manager_name`, [date]);
    return NextResponse.json({ date, count: r.rowCount, rows: r.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban morning]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать' }, { status: 500 });
  }
}
