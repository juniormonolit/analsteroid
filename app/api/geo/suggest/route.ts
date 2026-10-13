import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readWidgetGrant, WIDGET_TOKEN_HEADER } from '@/lib/bitrix/widgetGrant';
import { suggestAddress } from '@/lib/geo/resolve';

// Подсказки адреса при наборе (DaData suggest) для поля «Адрес идеальный».
export async function GET(req: NextRequest) {
  const session = await getSession().catch(() => null);
  if (!session && !(await readWidgetGrant(req.headers.get(WIDGET_TOKEN_HEADER)))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 200);
  return NextResponse.json({ candidates: await suggestAddress(q) });
}
