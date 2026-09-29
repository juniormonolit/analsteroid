import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics } from '@/lib/metrics/catalog';
import { RESPONSE_CATEGORY } from '@/lib/realizations/responseMetrics';

// Метрики «Ответов на запросы» (задача #8034) в общий каталог не отдаются: они
// считаются только движком slug 'requests-response' (раздел «Реализация»), в
// других отчётах были бы пустыми колонками. Колонки своего отчёта приходят в
// ответе /api/reports/run (поле metrics).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const metrics = await loadMetrics();
  return NextResponse.json({ metrics: metrics.filter(m => !m.isHiddenInUi && m.category !== RESPONSE_CATEGORY) });
}
