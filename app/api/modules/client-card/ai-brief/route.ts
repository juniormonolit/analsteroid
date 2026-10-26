import { NextRequest, NextResponse } from 'next/server';
import { moduleActor } from '@/lib/bitrix/widgetGrant';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { fetchManagerBrief } from '@/features/ai-analysis/engine/managerBrief';
import { aiRequestState, AiRequestError, requestAnalysis } from '@/features/ai-analysis/engine/requests';
import { getSession } from '@/lib/auth/session';

// «ИИ-анализ» для менеджера в карточке клиента (владелец 26.10): только разделы про заказчика из последнего
// разбора (managerBrief.ts). Доступ — как у карточки (moduleActor): сессия с доступом к клиенту или пропуск
// вкладки Битрикса. Разбора нет — { brief: null }; request — можно ли «Запросить разбор» (requests.ts).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const ref = parseClientRef(sp.get('contactId'), sp.get('companyId'));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  if (!(await moduleActor(req, ref))) return NextResponse.json({ error: 'Нет доступа — откройте карточку клиента заново' }, { status: 403 });
  try {
    const [brief, request] = await Promise.all([fetchManagerBrief(ref), aiRequestState(ref)]);
    return NextResponse.json({ brief, request }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[client-card/ai-brief]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить разбор' }, { status: 500 });
  }
}

/** POST { contactId|companyId, comment? } — «Запросить разбор» (26.10): разбора не было или есть свежие разговоры. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
  const ref = parseClientRef(str(body?.contactId), str(body?.companyId));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  const actor = await moduleActor(req, ref);
  if (!actor) return NextResponse.json({ error: 'Нет доступа — откройте карточку клиента заново' }, { status: 403 });
  const session = await getSession().catch(() => null);
  try {
    const request = await requestAnalysis(ref, { id: actor, name: session?.displayName ?? actor }, typeof body?.comment === 'string' ? body.comment : null);
    return NextResponse.json({ ok: true, request });
  } catch (e) {
    if (e instanceof AiRequestError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[client-card/ai-brief POST]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось запросить разбор' }, { status: 500 });
  }
}
