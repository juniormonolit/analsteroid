import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../../guard';
import { NoSnapshotError, parseFilter, parsePeriod, requireSnapshot } from '@/lib/supplyPanel/http';
import { dom } from '@/lib/supplyPanel/queries';

// «Ответы на запросы → Доля запросов»: сделки с товарами по доминирующему узлу каталога
// и доля сделок с запросом снабжению. Действует только фильтр region (как в панели).
export async function GET(req: NextRequest) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const sp = req.nextUrl.searchParams;
  const p = parsePeriod(sp);
  if (!p) return NextResponse.json({ error: 'Период задан неверно' }, { status: 400 });
  try {
    const s = await requireSnapshot();
    return NextResponse.json({ ...dom(s, p[0], p[1], { region: parseFilter(sp).region }), pulledAt: s.pulledAt });
  } catch (e) {
    if (e instanceof NoSnapshotError) return NextResponse.json({ error: e.message }, { status: 503 });
    console.error('[realizations/supply/dom]', (e as Error).message ?? e);
    return NextResponse.json({ error: 'Не удалось посчитать долю запросов' }, { status: 502 });
  }
}
