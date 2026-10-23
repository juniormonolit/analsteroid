import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { countToday, enqueue, MAX_PER_DAY } from '@/features/ai-analysis/engine/store';
import { fetchTaskCheckState, fetchTaskInfo, TASK_CHECK_VERSION } from '@/features/ai-analysis/engine/taskCheck';
import { kickAiWorker } from '@/features/ai-analysis/engine/worker';

// Проверка звонка по закрытой задаче (план повторки, владелец 23.10: «НЕ автоматически — пометка „есть звонок —
// проверить“ и запуск вручную»). Право — как у разбора (РОП).
//   GET ?taskIds=1,2,3 → { [taskId]: { hasCall, check: { id, status, verdict, at } | null } } — для пометки на доске;
//   POST { taskId } → { id } — поставить проверку в очередь; результат — GET /api/ai-analysis/{id}
//     (report_md: «### 1. Итог» … ; parsed.taskCheck: { verdict, items[] }).
async function guard() {
  const session = await getSession().catch(() => null);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!hasPerm(session, 'action.ai_call_analysis')) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

export async function GET(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const ids = (req.nextUrl.searchParams.get('taskIds') ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
  const state = await fetchTaskCheckState(ids);
  return NextResponse.json(Object.fromEntries(state));
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => ({})) as { taskId?: unknown };
  const taskId = Number(body.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) return NextResponse.json({ error: 'Укажите задачу' }, { status: 400 });
  try {
    const t = await fetchTaskInfo(taskId);
    if (!t) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    if (!t.clientRef) return NextResponse.json({ error: 'У задачи нет сделки с заказчиком' }, { status: 400 });
    if (!g.session.isSuperadmin && (await countToday(g.session.login)) >= MAX_PER_DAY) {
      return NextResponse.json({ error: `Лимит — ${MAX_PER_DAY} запусков в день` }, { status: 429 });
    }
    const id = await enqueue({ clientRef: t.clientRef, promptVersion: TASK_CHECK_VERSION, by: { login: g.session.login, name: g.session.displayName }, checkTaskId: taskId });
    kickAiWorker();
    return NextResponse.json({ id });
  } catch (e) {
    console.error('[ai-analysis/task-check]', e);
    return NextResponse.json({ error: 'Не удалось поставить проверку' }, { status: 500 });
  }
}
