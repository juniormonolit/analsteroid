import { NextRequest, NextResponse } from 'next/server';
import { moduleActor } from '@/lib/bitrix/widgetGrant';
import { fetchClientModule, parseClientRef } from '@/features/client-module/engine/clientModule';

// Модуль «Карточка клиента» (ТЗ владельца 13.10): все цифры и сделки клиента
// по ID контакта или компании Битрикса. Превью — «Ещё → Модули» (админ/право
// роли); вкладка в карточке Битрикса — по пропуску виджета.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ref = parseClientRef(sp.get('contactId'), sp.get('companyId'));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  // Админ/право роли «Модули» — любой клиент; вкладка в Битриксе — только «свой»
  // клиент по пропуску (lib/bitrix/widgetGrant.ts).
  if (!(await moduleActor(req, ref))) return NextResponse.json({ error: 'Нет доступа — откройте карточку клиента заново' }, { status: 403 });

  try {
    return NextResponse.json(await fetchClientModule(ref));
  } catch (e) {
    console.error('[modules/client-card]', e);
    return NextResponse.json({ error: 'Не удалось загрузить данные клиента' }, { status: 500 });
  }
}
