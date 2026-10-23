import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { listClientCalls } from '@/features/ai-analysis/engine/collect';
import { countToday, listForClient, MAX_PER_DAY } from '@/features/ai-analysis/engine/store';
import { getActivePrompt } from '@/features/ai-analysis/engine/promptStore';
import { openRepeatTask } from '@/features/ai-analysis/engine/memoStore';
import { transcribeCandidates, transcribeEnabled, TRANSCRIBE_MAX_CALLS } from '@/features/ai-analysis/engine/transcribe';

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
    const [calls, analyses, usedToday, task, tr] = await Promise.all([
      listClientCalls(ref, withText),
      withText ? Promise.resolve([]) : listForClient(ref),
      withText ? Promise.resolve(0) : countToday(session.login),
      withText ? Promise.resolve(null) : openRepeatTask(ref).catch(() => null),
      // Звонки без текста, которые расшифруем перед разбором (transcribe.ts); выключено — 0.
      withText || !transcribeEnabled() ? Promise.resolve(null) : transcribeCandidates(ref).catch(() => null),
    ]);
    const toTranscribe = tr ? { count: tr.send.length + tr.inWork.length, total: tr.total, max: TRANSCRIBE_MAX_CALLS } : null;
    const openTask = task ? { id: task.id, responsibleName: task.responsibleName } : null;
    return NextResponse.json({ ref, calls, analyses, openTask, toTranscribe, promptVersion: (await getActivePrompt()).version, quota: { used: usedToday, max: MAX_PER_DAY } });
  } catch (e) {
    console.error('[ai-analysis/client]', e);
    return NextResponse.json({ error: 'Не удалось загрузить звонки заказчика' }, { status: 500 });
  }
}
