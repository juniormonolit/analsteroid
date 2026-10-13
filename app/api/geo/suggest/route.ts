import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { suggestAddress } from '@/lib/geo/resolve';

// Подсказки адреса при наборе (DaData suggest) для поля «Адрес идеальный».
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 200);
  return NextResponse.json({ candidates: await suggestAddress(q) });
}
