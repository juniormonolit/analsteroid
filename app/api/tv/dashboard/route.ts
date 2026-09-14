import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/auth/pin';
import { buildDashboard } from '@/features/tv/engine/dashboard';
import { rateLimited, tooMany } from '@/features/tv/engine/rateLimit';

// Дашборд «Сегодня по компании» для страницы /today. Публичный (решение владельца 14.09),
// поэтому отдаём ПОЛНУЮ картину всем: резать состав по зоне ответственности сессии здесь
// бессмысленно — тот же ответ получает любой, кто открыл страницу без логина, а РОП
// видел бы меньше анонима. Защита — лимит на IP + noindex (см. app/robots.ts, next.config.ts).
// Данные кэшируются в Redis 20 с (features/tv/engine/dashboard.ts).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (rateLimited(`tv:dash:${ip ?? 'na'}`, 30, 60)) return tooMany();
  try {
    const dash = await buildDashboard();
    return NextResponse.json(dash, {
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' },
    });
  } catch (e) {
    console.error('[tv/dashboard]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать дашборд' }, { status: 500 });
  }
}
