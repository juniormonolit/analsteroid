import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchProductMatrix } from '@/features/reports/engine/productMatrix';

// «Товарная матрица» (задача владельца 10.08): вероятности перехода
// категория → категория. Вся математика — в движке; фильтр категорий — на
// клиенте (см. шапку productMatrix.ts: вероятности от всех переходов, чтобы
// скрытие колонок не меняло числа в оставшихся).

function isValidPeriodInput(p: unknown): p is { from: string; to: string } {
  if (!p || typeof p !== 'object') return false;
  const from = (p as Record<string, unknown>).from;
  const to = (p as Record<string, unknown>).to;
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return !Number.isNaN(new Date(from).getTime()) && !Number.isNaN(new Date(to).getTime());
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  if (!isValidPeriodInput(body.period)) {
    return NextResponse.json({ error: 'period.from и period.to обязательны и должны быть валидными датами' }, { status: 400 });
  }
  const start = Date.now();
  const result = await fetchProductMatrix({
    from: new Date(body.period.from),
    to: new Date(body.period.to),
  });
  return NextResponse.json({ ...result, meta: { durationMs: Date.now() - start } });
}
