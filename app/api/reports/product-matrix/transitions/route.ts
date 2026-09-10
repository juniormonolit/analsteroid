import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchMatrixTransitions } from '@/features/reports/engine/productMatrix';
import { resolveMatrixRequest } from '@/features/reports/engine/productMatrixRequest';

// Дрилл ячейки матрицы (задача владельца 10.09): разбивка по менеджеру
// закрывающей сделки + сами цепочки «предыдущая покупка → следующая».
// Фильтры и срез сессии — те же, что у самой матрицы (resolveMatrixRequest).
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  if (!from || !to) return NextResponse.json({ error: 'from и to (категории) обязательны' }, { status: 400 });

  const parsed = await resolveMatrixRequest(session, body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const drillManagerId = typeof body.drillManagerId === 'string' && /^\d+$/.test(body.drillManagerId)
    ? body.drillManagerId : undefined;
  const result = await fetchMatrixTransitions({ ...parsed.opts, from, to, drillManagerId });
  return NextResponse.json(result);
}
