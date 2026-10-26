import { NextRequest, NextResponse } from 'next/server';
import { moduleActor } from '@/lib/bitrix/widgetGrant';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { fetchManagerBrief } from '@/features/ai-analysis/engine/managerBrief';

// «ИИ-анализ» для менеджера в карточке клиента (владелец 26.10): только разделы про заказчика из последнего
// разбора (managerBrief.ts). Доступ — как у карточки (moduleActor): сессия с доступом к клиенту или пропуск
// вкладки Битрикса. Разбора нет — { brief: null }, вкладки нет.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const ref = parseClientRef(sp.get('contactId'), sp.get('companyId'));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  if (!(await moduleActor(req, ref))) return NextResponse.json({ error: 'Нет доступа — откройте карточку клиента заново' }, { status: 403 });
  try {
    return NextResponse.json({ brief: await fetchManagerBrief(ref) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[client-card/ai-brief]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить разбор' }, { status: 500 });
  }
}
