import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { listClientCalls } from '@/features/ai-analysis/engine/collect';
import { countToday, listForClient, MAX_PER_DAY } from '@/features/ai-analysis/engine/store';
import { PROMPT_VERSION } from '@/features/ai-analysis/engine/prompt';
import { openRepeatTask } from '@/features/ai-analysis/engine/memoStore';

// Вкладка «ИИ-анализ» карточки клиента: звонки заказчика (без текстов, ?texts=1 — с текстами) +
// прошлые анализы + лимит. Только право action.ai_call_analysis (решение владельца 22.10: «видят
// ТОЛЬКО РОПЫ»); без права — 403, и вкладка не показывается.
export async function GET(req: NextRequest) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'action.ai_call_analysis')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const ref = parseClientRef(sp.get('contactId'), sp.get('companyId'));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  const withText = sp.get('texts') === '1';
  try {
    const [calls, analyses, usedToday, task] = await Promise.all([
      listClientCalls(ref, withText),
      withText ? Promise.resolve([]) : listForClient(ref),
      withText ? Promise.resolve(0) : countToday(session.login),
      withText ? Promise.resolve(null) : openRepeatTask(ref).catch(() => null),
    ]);
    const openTask = task ? { id: task.id, responsibleName: task.responsibleName } : null;
    return NextResponse.json({ ref, calls, analyses, openTask, promptVersion: PROMPT_VERSION, quota: { used: usedToday, max: MAX_PER_DAY } });
  } catch (e) {
    console.error('[ai-analysis/client]', e);
    return NextResponse.json({ error: 'Не удалось загрузить звонки заказчика' }, { status: 500 });
  }
}
