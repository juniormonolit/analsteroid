import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { buildSheetResult } from '@/features/decomposition/engine/sheetFact';
import { SHEET_NAMES } from '@/features/decomposition/sheets';

// «ССП тест», лист отдела: план (xlsx, лист «<филиал> (<отдел>)») и факт по
// блокам показателей × товарным группам × месяцам. Гейт — как у /decomposition.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.decomposition')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const sheet = req.nextUrl.searchParams.get('sheet') ?? '';
  if (!SHEET_NAMES.includes(sheet)) return NextResponse.json({ error: 'sheet: неизвестный лист', sheets: SHEET_NAMES }, { status: 400 });
  const year = Number(req.nextUrl.searchParams.get('year') ?? 2026);
  if (!Number.isInteger(year) || year < 2025 || year > 2030) return NextResponse.json({ error: 'year' }, { status: 400 });
  const asOfRaw = req.nextUrl.searchParams.get('asOf');
  const asOf = asOfRaw && /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : undefined;
  try {
    const res = await buildSheetResult(sheet, year, asOf);
    if (!res) return NextResponse.json({ error: 'Лист не найден' }, { status: 404 });
    return NextResponse.json(res);
  } catch (e) {
    console.error('[decomposition/sheet]', e);
    return NextResponse.json({ error: 'Не удалось рассчитать план/факт по листу' }, { status: 500 });
  }
}
