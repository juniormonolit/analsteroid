import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../../guard';
import { NoSnapshotError, parseFilter, parsePeriod, requireSnapshot } from '@/lib/supplyPanel/http';
import { goods } from '@/lib/supplyPanel/queries';

// «Ответы на запросы → Товары»: дерево каталога Bitrix24 по позициям новых запросов периода.
export async function GET(req: NextRequest) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const sp = req.nextUrl.searchParams;
  const p = parsePeriod(sp);
  if (!p) return NextResponse.json({ error: 'Период задан неверно' }, { status: 400 });
  try {
    const s = await requireSnapshot();
    return NextResponse.json({ ...goods(s, p[0], p[1], parseFilter(sp)), pulledAt: s.pulledAt });
  } catch (e) {
    if (e instanceof NoSnapshotError) return NextResponse.json({ error: e.message }, { status: 503 });
    console.error('[realizations/supply/goods]', (e as Error).message ?? e);
    return NextResponse.json({ error: 'Не удалось посчитать товары' }, { status: 502 });
  }
}
