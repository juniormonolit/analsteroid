import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseMcp, issueCode, takeConsentRequest } from '@/lib/mcp/oauth';

// Нажатие «Разрешить»/«Отмена» на /oauth/authorize. Параметры OAuth берутся из сохранённого
// запроса согласия (не из формы): форма несёт только одноразовый id, привязанный к человеку.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL('/login', req.url), 303);
  const form = await req.formData();
  const requestId = String(form.get('request_id') ?? '');
  const decision = String(form.get('decision') ?? '');

  const p = requestId ? await takeConsentRequest(requestId, session.id) : null;
  if (!p) {
    return new NextResponse('Запрос устарел. Вернитесь в Claude и подключите коннектор ещё раз.', {
      status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const back = new URL(p.redirectUri);
  if (p.state) back.searchParams.set('state', p.state);
  if (decision !== 'allow' || !canUseMcp(session)) {
    back.searchParams.set('error', 'access_denied');
    return NextResponse.redirect(back, 303);
  }
  back.searchParams.set('code', await issueCode(session.id, p));
  return NextResponse.redirect(back, 303);
}
