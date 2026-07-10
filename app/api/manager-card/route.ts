import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildManagerCard, type CardSegment } from '@/features/manager-card/engine/managerCard';
import type { ProductGroupMode } from '@/lib/metrics/types';

// Карточка менеджера (экран 1 мокапа manager-card-mock.html, MVP): профиль +
// паутина метрик шаблона (период/всё время) + рейтинг/ранг + итоги периода + топ-5
// категорий + тизер звонков. См. features/manager-card/engine/managerCard.ts.
//
// Задача 10.07 (пакет «шаблоны + карточка v3»): период сравнения и система
// категорий теперь настраиваемые (п.3/п.4) — оба опциональны, дефолты сохраняют
// прежнее поведение (previousPeriod(period) / 'kc').
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { managerId, period, comparisonPeriod, segment = 'all' as CardSegment, productGroupMode } = body;

  if (!managerId || typeof managerId !== 'string' || !/^\d+$/.test(managerId)) {
    return NextResponse.json({ error: 'managerId (числовой bitrix_user_id) обязателен' }, { status: 400 });
  }
  if (!period?.from || !period?.to) {
    return NextResponse.json({ error: 'period.from/period.to обязательны' }, { status: 400 });
  }
  if (comparisonPeriod !== undefined && (!comparisonPeriod?.from || !comparisonPeriod?.to)) {
    return NextResponse.json({ error: 'comparisonPeriod, если передан, должен содержать from/to' }, { status: 400 });
  }
  if (!['all', 'fl', 'ul'].includes(segment)) {
    return NextResponse.json({ error: 'segment должен быть all/fl/ul' }, { status: 400 });
  }
  if (productGroupMode !== undefined && !['kc', 'by_max'].includes(productGroupMode)) {
    return NextResponse.json({ error: 'productGroupMode должен быть kc/by_max' }, { status: 400 });
  }

  const start = Date.now();
  const result = await buildManagerCard({
    managerId,
    period: { from: new Date(period.from), to: new Date(period.to) },
    comparisonPeriod: comparisonPeriod ? { from: new Date(comparisonPeriod.from), to: new Date(comparisonPeriod.to) } : undefined,
    segment,
    productGroupMode: productGroupMode as ProductGroupMode | undefined,
  });

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  return NextResponse.json({ ...result, meta: { ...result.meta, durationMs: Date.now() - start } });
}
