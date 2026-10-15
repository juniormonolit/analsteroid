import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../../guard';
import { NoSnapshotError, parseFilter, parsePeriod, requireSnapshot } from '@/lib/supplyPanel/http';
import { domDeals } from '@/lib/supplyPanel/queries';

// «Доля запросов»: сделки узла каталога. kind=dom — где узел доминирует, has — где есть позиция.
export async function GET(req: NextRequest) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const sp = req.nextUrl.searchParams;
  const p = parsePeriod(sp);
  if (!p) return NextResponse.json({ error: 'Период задан неверно' }, { status: 400 });
  const node = sp.get('node') ?? '';
  const kind = sp.get('kind') === 'has' ? 'has' : 'dom';
  if (!/^[\w:.\-]+$/.test(node)) return NextResponse.json({ error: 'Некорректный узел' }, { status: 400 });
  try {
    const s = await requireSnapshot();
    return NextResponse.json({ ...domDeals(s, p[0], p[1], node, kind, { region: parseFilter(sp).region }), pulledAt: s.pulledAt });
  } catch (e) {
    if (e instanceof NoSnapshotError) return NextResponse.json({ error: e.message }, { status: 503 });
    console.error('[realizations/supply/dom-deals]', (e as Error).message ?? e);
    return NextResponse.json({ error: 'Не удалось загрузить сделки' }, { status: 502 });
  }
}
