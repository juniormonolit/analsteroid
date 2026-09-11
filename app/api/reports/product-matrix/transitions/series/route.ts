import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchTransitionSeries, type TransitionSeriesStep } from '@/features/reports/engine/productMatrix';
import { resolveMatrixRequest } from '@/features/reports/engine/productMatrixRequest';

// Динамика одной ячейки матрицы во времени (правка владельца 11.09: «кнопка
// графика на каждом квадратике, как в основных отчётах»). Фильтры и срез сессии —
// те же, что у матрицы и её дрилла (resolveMatrixRequest).
const STEPS: TransitionSeriesStep[] = ['day', 'week', 'month'];

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  if (!from || !to) return NextResponse.json({ error: 'from и to (категории) обязательны' }, { status: 400 });

  // Шаг — из белого списка: значение подставляется в date_trunc текстом.
  const step: TransitionSeriesStep = STEPS.includes(body.step) ? body.step : 'week';

  const parsed = await resolveMatrixRequest(session, body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const result = await fetchTransitionSeries({ ...parsed.opts, from, to, step });
  return NextResponse.json(result);
}
