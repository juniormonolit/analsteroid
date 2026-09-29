import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../guard';
import { parseFilters, matchRow } from '@/lib/realizations/filters';
import { loadPeriodRows, loadStatusIntervals, loadOverdue, loadOrphanPurchases, loadLogists } from '@/lib/realizations/data';
import { buildSummary, statusTimes } from '@/lib/realizations/metrics';
import { regionOf } from '@/lib/realizations/region';

// Сводка «Реализации»: by=logist — по логистам, by=region — по регионам.
// Фильтр статуса к сводке не применяется (М1 считает все группы статусов).
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const sp = req.nextUrl.searchParams;
  const f = parseFilters(sp);
  if ('error' in f) return NextResponse.json({ error: f.error }, { status: 400 });
  const by = sp.get('by') === 'region' ? 'region' : 'logist';
  try {
    const [rows, intervals, overdue, orphans, logists] = await Promise.all([
      loadPeriodRows(f.from, f.to), loadStatusIntervals(f.from, f.to), loadOverdue(),
      loadOrphanPurchases(f.from, f.to), loadLogists('2024-01-01'),
    ]);
    const names = new Map(logists.map(l => [l.id, l.name] as const));
    const scope = { region: f.region, logist: f.logist, status: null };
    const nameOf = (id: string | null) => (id ? names.get(id) ?? null : null);
    const scopedRows = rows.filter(r => matchRow(r, scope));
    const scopedOverdue = overdue.filter(o => matchRow({ logist_id: o.logist_id, logist: nameOf(o.logist_id), status: '', grp: 'in_work' }, scope));
    const scopedIntervals = intervals.filter(x => matchRow({ logist_id: x.logist_id, logist: nameOf(x.logist_id), status: '', grp: 'in_work' }, scope));
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    const summary = buildSummary(scopedRows, scopedOverdue, by, today, names);
    return NextResponse.json({
      filters: f, by, today, ...summary,
      statusTimes: statusTimes(scopedIntervals),
      // М12 не режется по региону/логисту: у приобретения без заявки логиста нет.
      orphans,
      options: { logists: logists.filter(l => rows.some(r => r.logist_id === l.id)).map(l => ({ ...l, region: regionOf(l.name) })) },
    });
  } catch (e) {
    console.error('[realizations/summary]', e);
    return NextResponse.json({ error: 'Не удалось получить заявки из 1С — попробуйте обновить страницу' }, { status: 502 });
  }
}
