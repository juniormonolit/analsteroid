import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseModules } from '@/lib/auth/modulesAccess';
import { fetchClientModule, parseClientRef } from '@/features/client-module/engine/clientModule';

// Модуль «Карточка клиента» (ТЗ владельца 13.10): все цифры и сделки клиента
// по ID контакта или компании Битрикса. Пока — превью в «Ещё → Модули» (только
// админ/право роли); для виджета в Битриксе появится отдельный embed-вход.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canUseModules(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const ref = parseClientRef(sp.get('contactId'), sp.get('companyId'));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });

  try {
    return NextResponse.json(await fetchClientModule(ref));
  } catch (e) {
    console.error('[modules/client-card]', e);
    return NextResponse.json({ error: 'Не удалось загрузить данные клиента' }, { status: 500 });
  }
}
