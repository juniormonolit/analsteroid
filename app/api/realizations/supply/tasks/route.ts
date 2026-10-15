import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../../guard';
import { NoSnapshotError, parseFilter, parsePeriod, requireSnapshot } from '@/lib/supplyPanel/http';
import { PICK } from '@/lib/supplyPanel/metrics';
import { tasks } from '@/lib/supplyPanel/queries';

// «Ответы на запросы»: список задач, из которых сложилась цифра (как /api/tasks панели).
// metric — ключ показателя панели (new, answers, gt9_pct …); path — узел дерева «Товары».
export async function GET(req: NextRequest) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const sp = req.nextUrl.searchParams;
  const p = parsePeriod(sp);
  if (!p) return NextResponse.json({ error: 'Период задан неверно' }, { status: 400 });
  const metric = sp.get('metric') ?? 'new';
  if (!Object.prototype.hasOwnProperty.call(PICK, metric)) return NextResponse.json({ error: 'Неизвестный показатель' }, { status: 400 });
  const path = sp.get('path') ?? '';
  if (path && !/^[\w:.\-/%а-яё ]+$/i.test(path)) return NextResponse.json({ error: 'Некорректный узел' }, { status: 400 });
  try {
    const s = await requireSnapshot();
    return NextResponse.json({ ...tasks(s, p[0], p[1], metric, parseFilter(sp), path), pulledAt: s.pulledAt });
  } catch (e) {
    if (e instanceof NoSnapshotError) return NextResponse.json({ error: e.message }, { status: 503 });
    console.error('[realizations/supply/tasks]', (e as Error).message ?? e);
    return NextResponse.json({ error: 'Не удалось загрузить запросы' }, { status: 502 });
  }
}
