import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchDealAddresses } from '@/lib/bitrix/dealAddress';

// Адреса объектов сделок (задача владельца 21.09): карточка сделки и список
// сделок заказчика спрашивают их по id. Свежее отдаётся из кэша deal_addresses,
// промахи дозапрашиваются у Битрикса и складываются туда же — раздел сам
// прогревает кэш по мере работы менеджеров.
//
// Доступ — любая сессия: адрес объекта видит тот, кто и так видит саму сделку,
// отдельного ограничения по зоне ответственности здесь нет (карточка сделки
// доступна по тем же правилам, что и раньше).

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const raw = req.nextUrl.searchParams.get('ids') ?? '';
  const ids = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0).slice(0, 200);
  if (ids.length === 0) return NextResponse.json({ addresses: {} });

  const map = await fetchDealAddresses(ids);
  const addresses: Record<string, { address: string | null; lat: number | null; lon: number | null }> = {};
  for (const [id, a] of map) addresses[String(id)] = { address: a.address, lat: a.lat, lon: a.lon };
  return NextResponse.json({ addresses });
}
