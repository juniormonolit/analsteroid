// Загрузка «Карты показателей» (контракт — features/metric-map/types.ts).
// Пока движок не отвечает (404 — роута ещё нет) — в dev подставляем фикстуру,
// чтобы интерфейс можно было разрабатывать и проверять; на проде — честная ошибка.
import { format } from 'date-fns';
import type { MapScope, MetricMapResponse } from '../types';
import { buildFixture } from './fixture';

export interface MapQuery {
  scope: string;          // company | department:<id> | manager:<id> | product_group:<id>
  scopeLabel: string;
  from: Date; to: Date;
  compareFrom: Date; compareTo: Date;
  periodLabel: string;
  compareLabel: string;
  forceFixture?: boolean;
}

export type MapResult = MetricMapResponse & { demo?: boolean };

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
const IS_DEV = process.env.NODE_ENV === 'development';

function fixtureFor(q: MapQuery): MapResult {
  const [type, id] = q.scope.split(':') as [MapScope['type'], string | undefined];
  return {
    ...buildFixture(
      { type, id: id ?? null, label: q.scopeLabel },
      { from: ymd(q.from), to: ymd(q.to), label: q.periodLabel },
      { from: ymd(q.compareFrom), to: ymd(q.compareTo), label: q.compareLabel },
    ),
    demo: true,
  };
}

export async function fetchMetricMap(q: MapQuery): Promise<MapResult> {
  if (IS_DEV && q.forceFixture) return fixtureFor(q);
  const sp = new URLSearchParams({
    scope: q.scope,
    from: ymd(q.from), to: ymd(q.to),
    compareFrom: ymd(q.compareFrom), compareTo: ymd(q.compareTo),
  });
  const res = await fetch(`/api/metric-map?${sp}`);
  // Фикстура — только когда роута нет (HTML-страница 404), не на JSON-404 «Отдел не найден».
  if (res.status === 404 && IS_DEV) {
    const b = await res.clone().json().catch(() => null);
    if (!b?.error) return fixtureFor(q);
  }
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(b?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function recomputeMetricMap(): Promise<{ ok: true; computedAt: string }> {
  const res = await fetch('/api/metric-map/recompute', { method: 'POST' });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(b?.error ?? (res.status === 404 ? 'Пересчёт ещё не подключён' : `HTTP ${res.status}`));
  }
  return res.json();
}
