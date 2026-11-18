import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { requestTranscription, transcribeCandidates, transcribeEnabled, transcriptionState } from '@/features/ai-analysis/engine/transcribe';

// Вкладка «Звонки» карточки задачи канбана больших чеков (собрание РОПов 18.11): «кнопка отправить на
// транскрибацию звонков, где текста нет». Отправляет звонки заказчика без текста в общую очередь
// расшифровки (сервер транскрибации, n8n transcribe-on-demand — engine/transcribe.ts), готовность —
// опросом GET ?ids=. Право то же, что у звонков заказчика: action.ai_call_analysis (РОПы).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function guard() {
  const session = await getSession().catch(() => null);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!hasPerm(session, 'action.ai_call_analysis')) return { error: NextResponse.json({ error: 'Звонки видят только РОПы' }, { status: 403 }) };
  return { session };
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if ('error' in g) return g.error;
  if (!transcribeEnabled()) return NextResponse.json({ error: 'Расшифровка по кнопке не настроена' }, { status: 503 });
  const body = await req.json().catch(() => ({})) as { contactId?: unknown; companyId?: unknown };
  const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  const ref = parseClientRef(str(body.contactId), str(body.companyId));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  try {
    const c = await transcribeCandidates(ref);
    if (!c.send.length) return NextResponse.json({ sent: 0, inWork: c.inWork.length, ids: c.inWork });
    const r = await requestTranscription(c.send, g.session.login, 'big-deals-kanban');
    if (r.kind === 'rate_limited') {
      return NextResponse.json({ sent: 0, inWork: c.inWork.length, ids: c.inWork, rateLimitedSec: r.retryAfterSec }, { status: 429 });
    }
    if (r.kind === 'error') {
      return NextResponse.json({ sent: 0, inWork: c.inWork.length, ids: c.inWork, error: 'Сервис расшифровки не ответил, попробуйте позже' }, { status: 502 });
    }
    const ids = [...new Set([...r.accepted, ...r.inProgress, ...c.inWork])];
    return NextResponse.json({ sent: r.accepted.length, inWork: r.inProgress.length + c.inWork.length, ids });
  } catch (e) {
    console.error('[big-deals-kanban/transcribe]', e);
    return NextResponse.json({ error: 'Не удалось отправить звонки на расшифровку' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const g = await guard();
  if ('error' in g) return g.error;
  const ids = (req.nextUrl.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(s => UUID_RE.test(s)).slice(0, 100);
  try {
    return NextResponse.json(await transcriptionState(ids));
  } catch (e) {
    console.error('[big-deals-kanban/transcribe GET]', e);
    return NextResponse.json({ error: 'Не удалось проверить расшифровку' }, { status: 500 });
  }
}
