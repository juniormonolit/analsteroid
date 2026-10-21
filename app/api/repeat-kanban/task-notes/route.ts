import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { fetchTaskNotes } from '@/features/repeat-kanban/engine/taskNotes';

// Последние комментарии по задачам видимых карточек канбана повторных (taskNotes.ts).
// Отдельно от доски: идёт в Битрикс, доска не должна его ждать. Только задачи проекта
// «Повторные продажи» — чужие задачи по id отсюда не прочитать.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const ids = (req.nextUrl.searchParams.get('ids') ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 400);
  try {
    const notes = await fetchTaskNotes(ids);
    return NextResponse.json({ notes: Object.fromEntries(notes) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban task-notes]', e instanceof Error ? e.message : e);
    return NextResponse.json({ notes: {} });
  }
}
