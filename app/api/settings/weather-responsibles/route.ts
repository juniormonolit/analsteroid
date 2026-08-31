import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { getWeatherResponsibles, setWeatherResponsible } from '@/lib/weather/weeklyWeather';
import type { WeatherCity } from '@/lib/weather/openMeteo';

// Настройка «Кого спрашивать по погоде» (владелец 28.08) — город → Bitrix ID.
export async function GET() {
  const session = await getSession();
  const err = permError(session, 'section.settings');
  if (err) return err;
  return NextResponse.json({ responsibles: await getWeatherResponsibles() });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const err = permError(session, 'section.settings');
  if (err) return err;
  const body = await req.json().catch(() => null) as { city?: string; bitrixUserId?: string } | null;
  const city = String(body?.city ?? '');
  const id = String(body?.bitrixUserId ?? '').trim();
  if (!['spb', 'msk', 'krd'].includes(city) || !/^\d{1,10}$/.test(id)) {
    return NextResponse.json({ error: 'city (spb|msk|krd) и числовой bitrixUserId обязательны' }, { status: 400 });
  }
  await setWeatherResponsible(city as WeatherCity, id);
  return NextResponse.json({ ok: true });
}
