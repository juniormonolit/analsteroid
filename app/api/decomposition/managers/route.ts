import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { buildManagersResult } from '@/features/decomposition/engine/sheetFact';

// «ССП тест», лист «Менеджеры»: план отгрузок/продаж по менеджерам из xlsx против
// факта по тем же Bitrix user id. Гейт — как у /decomposition.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.decomposition')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const year = Number(req.nextUrl.searchParams.get('year') ?? 2026);
  if (!Number.isInteger(year) || year < 2025 || year > 2030) return NextResponse.json({ error: 'year' }, { status: 400 });
  const asOfRaw = req.nextUrl.searchParams.get('asOf');
  const asOf = asOfRaw && /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : undefined;
  try {
    return NextResponse.json(await buildManagersResult(year, asOf));
  } catch (e) {
    console.error('[decomposition/managers]', e);
    return NextResponse.json({ error: 'Не удалось рассчитать план/факт по менеджерам' }, { status: 500 });
  }
}
