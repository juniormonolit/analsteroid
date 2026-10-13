import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { getDecompositionPlanFact } from '@/features/decomposition/engine/planFact';

// «ССП тест» (задача владельца 10.10): декомпозиция года (лист «Общая») против
// факта отгрузок по месяцам. Гейт — тот же, что у раздела «Декомпозиция»
// (app/(app)/decomposition/layout.tsx): администратор ИЛИ право section.decomposition.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.decomposition')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const yearRaw = req.nextUrl.searchParams.get('year');
  const nowYear = new Date().getFullYear();
  const year = yearRaw ? Number(yearRaw) : nowYear;
  // План в data.ts — только 2026; другие годы вернут факт без плана, но валидируем диапазон.
  if (!Number.isInteger(year) || year < 2025 || year > nowYear + 1) {
    return NextResponse.json({ error: 'year: целое число от 2025' }, { status: 400 });
  }
  const asOfRaw = req.nextUrl.searchParams.get('asOf');
  const asOf = asOfRaw && /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : undefined;
  try {
    return NextResponse.json(await getDecompositionPlanFact(year, asOf));
  } catch (e) {
    console.error('[decomposition/plan-fact]', e);
    return NextResponse.json({ error: 'Не удалось рассчитать план/факт' }, { status: 500 });
  }
}
