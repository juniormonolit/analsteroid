import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { reverseGeocode } from '@/lib/geo/resolve';
import { validLatLon } from '@/lib/geo/parse';

// Что в точке (после перетаскивания метки на мини-карте): адрес, населённый
// пункт, район, область. Точность — 'pin': точку поставил человек.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const lat = Number(req.nextUrl.searchParams.get('lat'));
  const lon = Number(req.nextUrl.searchParams.get('lon'));
  if (!validLatLon(lat, lon)) return NextResponse.json({ error: 'Некорректные координаты' }, { status: 400 });
  return NextResponse.json({ candidate: await reverseGeocode({ lat, lon }, 'manual') });
}
