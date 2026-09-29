import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../guard';
import { parseFilters, matchRow } from '@/lib/realizations/filters';
import { loadPeriodRows, loadLogists } from '@/lib/realizations/data';
import { requestMargin } from '@/lib/realizations/metrics';
import { regionOf } from '@/lib/realizations/region';

// «Продажи → Реализация»: список заявок sd.requests в разрезе логистов.
export const maxDuration = 60;
const MAX_ROWS = 5000;

export async function GET(req: NextRequest) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const f = parseFilters(req.nextUrl.searchParams);
  if ('error' in f) return NextResponse.json({ error: f.error }, { status: 400 });
  try {
    const [rows, logists] = await Promise.all([loadPeriodRows(f.from, f.to), loadLogists(f.from)]);
    const statuses = [...new Set(rows.map(r => r.status))].sort((a, b) => a.localeCompare(b, 'ru'));
    const filtered = rows.filter(r => matchRow(r, f));
    const items = filtered.slice(0, MAX_ROWS).map(r => ({
      id: r.id, number: r.number, docDate: r.doc_date, status: r.status, grp: r.grp,
      buyer: r.buyer, manager: r.manager, logistId: r.logist_id, logist: r.logist, region: regionOf(r.logist),
      shipmentDate: r.shipment_date, salesNv: r.sales_nv, purchNv: r.purch_nv,
      purchasesN: r.purchases_n ?? 0, broken: r.broken, marginNv: r.grp === 'cancelled' ? null : requestMargin(r),
    }));
    const totals = filtered.reduce((a, r) => {
      a.salesNv += r.sales_nv ?? 0;
      const m = r.grp === 'cancelled' ? null : requestMargin(r);
      if (m !== null) { a.marginNv += m; a.mSalesNv += r.sales_nv ?? 0; a.purchNv += r.purch_nv ?? 0; }
      return a;
    }, { salesNv: 0, purchNv: 0, marginNv: 0, mSalesNv: 0 });
    return NextResponse.json({
      filters: f, total: filtered.length, truncated: filtered.length > MAX_ROWS, items, totals,
      options: { logists: logists.map(l => ({ ...l, region: regionOf(l.name) })), statuses },
    });
  } catch (e) {
    console.error('[realizations/requests]', e);
    return NextResponse.json({ error: 'Не удалось получить данные базы Диспетчера' }, { status: 502 });
  }
}
