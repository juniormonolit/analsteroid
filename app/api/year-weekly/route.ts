import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { buildYearWeekly } from '@/features/year-weekly/engine/yearWeekly';

// Спец-отчёт «Данные по годам» (решения владельца 28.08, BACKLOG). Считается
// на лету из sa.deals — в отличие от ручного файла, не отстаёт на две недели.
export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = permError(session, 'section.year_weekly');
  if (err) return err;

  const yearRaw = req.nextUrl.searchParams.get('year');
  const now = new Date().getFullYear();
  const year = yearRaw ? Number(yearRaw) : now;
  // 2025 — старт данных sa.deals (ALL_TIME_START), сравнивать 2025 не с чем,
  // но сам 2025 показать можно.
  if (!Number.isInteger(year) || year < 2025 || year > now + 1) {
    return NextResponse.json({ error: 'year: целое число от 2025' }, { status: 400 });
  }
  return NextResponse.json(await buildYearWeekly(year));
}
