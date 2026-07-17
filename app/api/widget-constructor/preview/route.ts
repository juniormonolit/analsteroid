import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCachedWidgetMetrics } from '@/lib/jobs/widgetMetrics';
import { sliceForConfig } from '@/lib/widget/resolve';
import { validateWidgetConfig } from '@/lib/widget/config';

// Живое превью конструктора: тот же срез, что отдаст виджет, но по НЕсохранённому конфигу
// из тела (сессионно, без токена). POST, т.к. конфиг сложный.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const result = validateWidgetConfig(body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const blob = await getCachedWidgetMetrics();
  if (!blob) return NextResponse.json({ error: 'Данные ещё не рассчитаны' }, { status: 503 });

  const slice = sliceForConfig(blob, result.config);
  if (!slice) return NextResponse.json({ error: 'Разрез недоступен' }, { status: 404 });

  return NextResponse.json(slice);
}
