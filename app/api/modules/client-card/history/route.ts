import { NextRequest, NextResponse } from 'next/server';
import { moduleActor } from '@/lib/bitrix/widgetGrant';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { fetchClientHistory } from '@/features/client-module/engine/history';

// Единая «Карточка клиента» (20.10): путь покупок, лента звонков, кто вёл. Тот же
// доступ, что у основной ручки модуля: сессия с видимостью клиента или пропуск вкладки
// Битрикса на этого клиента (lib/bitrix/widgetGrant.ts).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ref = parseClientRef(sp.get('contactId'), sp.get('companyId'));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  if (!(await moduleActor(req, ref))) return NextResponse.json({ error: 'Нет доступа — откройте карточку клиента заново' }, { status: 403 });
  try {
    return NextResponse.json(await fetchClientHistory(ref));
  } catch (e) {
    console.error('[modules/client-card/history]', e);
    return NextResponse.json({ error: 'Не удалось загрузить историю клиента' }, { status: 500 });
  }
}
