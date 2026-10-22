import { NextResponse } from 'next/server';
import { guardRealizations } from '../../guard';
import { NoSnapshotError, requireSnapshot } from '@/lib/supplyPanel/http';
import { lastPanelVersion } from '@/lib/supplyPanel/version';

// «Ответы на запросы»: свежесть данных и справочники фильтров (регионы, департаменты, проекты).
export async function GET() {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  try {
    const s = await requireSnapshot();
    const projects = Object.entries(s.facts.projects).map(([id, p]) => ({ id: Number(id), name: p.name, region: p.region, dept: p.dept }));
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, 'ru'));
    return NextResponse.json({
      builtAt: s.builtAt, pulledAt: s.pulledAt, catalogAt: s.catalogAt, goodsSince: s.facts.goods_since,
      // methodChanged — код панели новее порта: цифры могут расходиться с панелью до переноса правок.
      methodChanged: lastPanelVersion()?.matches === false,
      regions: uniq(projects.map(p => p.region)), depts: uniq(projects.map(p => p.dept)), projects,
    });
  } catch (e) {
    if (e instanceof NoSnapshotError) return NextResponse.json({ error: e.message }, { status: 503 });
    console.error('[realizations/supply/meta]', (e as Error).message ?? e);
    return NextResponse.json({ error: 'Не удалось прочитать данные панели' }, { status: 502 });
  }
}
