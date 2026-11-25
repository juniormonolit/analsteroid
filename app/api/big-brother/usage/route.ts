import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewBigBrother } from '@/lib/activity/access';
import { loadUsage } from '@/features/big-brother/engine/usage/load';
import type { UsageDto } from '@/features/big-brother/engine/usage/types';

// «Большой брат» → «Использование»: отчёты (живые/мёртвые, отскок, глубина, параметры, скорость), мобильный срез,
// внедрение фич по changelog. Доступ — как у раздела (директор и выше). Кэш 2 мин: выборки по журналу за 90 дней.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

let cache: { at: number; data: UsageDto } | null = null;

export async function GET(req: Request) {
  const session = await getSession();
  if (!canViewBigBrother(session)) return NextResponse.json({ error: 'нет доступа' }, { status: 403 });
  const fresh = new URL(req.url).searchParams.get('fresh') === '1';
  if (!fresh && cache && Date.now() - cache.at < 120_000) return NextResponse.json(cache.data);
  const data = await loadUsage();
  cache = { at: Date.now(), data };
  return NextResponse.json(data);
}
