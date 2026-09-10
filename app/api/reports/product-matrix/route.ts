import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchProductMatrix } from '@/features/reports/engine/productMatrix';
import { resolveMatrixRequest } from '@/features/reports/engine/productMatrixRequest';

// «Товарная матрица» (10.08) и «Матрица переходов» (10.09) — один роут: разбор
// тела и срез сессии в resolveMatrixRequest, вся математика — в движке.
// Фильтр категорий остаётся на клиенте (см. шапку productMatrix.ts).
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parsed = await resolveMatrixRequest(session, body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const start = Date.now();
  const result = await fetchProductMatrix(parsed.opts);
  console.log(`[product-matrix] ${result.cells.length} ячеек за ${Date.now() - start} мс`);
  return NextResponse.json(result);
}
