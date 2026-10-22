import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { activeForClient, countToday, enqueue, MAX_PER_DAY } from '@/features/ai-analysis/engine/store';
import { PROMPT_VERSION } from '@/features/ai-analysis/engine/prompt';
import { kickAiWorker } from '@/features/ai-analysis/engine/worker';

// «Запустить анализ» во вкладке «ИИ-анализ». Ставит в очередь (ai_analyses), воркер подхватывает
// сразу. Один активный анализ на заказчика; лимит запусков в день на человека (MAX_PER_DAY).
export async function POST(req: NextRequest) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'action.ai_call_analysis')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { contactId?: string; companyId?: string };
  const ref = parseClientRef(body.contactId ?? null, body.companyId ?? null);
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  try {
    const active = await activeForClient(ref);
    if (active) return NextResponse.json({ id: active.id, already: true });
    if (!session.isSuperadmin && (await countToday(session.login)) >= MAX_PER_DAY) {
      return NextResponse.json({ error: `Лимит — ${MAX_PER_DAY} анализов в день. Завтра снова можно.` }, { status: 429 });
    }
    const id = await enqueue({ clientRef: ref, promptVersion: PROMPT_VERSION, by: { login: session.login, name: session.displayName } });
    kickAiWorker();
    return NextResponse.json({ id });
  } catch (e) {
    console.error('[ai-analysis/run]', e);
    return NextResponse.json({ error: 'Не удалось запустить анализ' }, { status: 500 });
  }
}
