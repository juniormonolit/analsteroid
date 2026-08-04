import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Найдено при работе над Правами v2: в отличие от соседних /api/settings/*
// (tables, metrics, metric-colors — все гейтят section.settings), этот роут
// проверял только факт логина — любая роль (включая «Пользователь») могла
// дёрнуть POST и перезаписать working_calendar на весь год. Гейт вернули в
// соответствие с остальными /api/settings/* (см. отчёт задачи).
export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const db = systemDb();
  const res = await db.query<{ year: number }>(
    `SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS year
     FROM working_calendar
     ORDER BY year`
  );

  return NextResponse.json({
    years: res.rows.map(r => r.year),
    total: res.rows.length,
  });
}

// Самопроверка построенного года перед записью в working_calendar:
// - число дней = 365/366 (с учётом високосного года);
// - ни одной даты вне запрошенного года;
// - число нерабочих дней (выходные + праздники) в правдоподобном диапазоне
//   104–119 — при перекосе часового пояса на сутки эта проверка не ловит
//   сдвиг напрямую, но ловит усечение/задвоение дней, которое тем же багом
//   и вызывалось (см. задачу 3066).
function validateCalendarRows(
  year: number,
  rows: { date: string; isWorking: boolean }[]
): string | null {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const expectedDays = isLeap ? 366 : 365;
  if (rows.length !== expectedDays) {
    return `ожидалось ${expectedDays} дней в ${year} году, получено ${rows.length}`;
  }

  const outOfYear = rows.find(r => !r.date.startsWith(String(year)));
  if (outOfYear) {
    return `дата вне запрошенного года: ${outOfYear.date}`;
  }

  const nonWorking = rows.filter(r => !r.isWorking).length;
  if (nonWorking < 104 || nonWorking > 119) {
    return `подозрительное число выходных/праздников: ${nonWorking} (ожидается 104–119)`;
  }

  return null;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const body = await req.json();
  const { year } = body as { year: number };

  if (!year || typeof year !== 'number') {
    return NextResponse.json({ error: 'year is required' }, { status: 400 });
  }

  const apiRes = await fetch(`https://isdayoff.ru/api/getdata?year=${year}`);
  if (!apiRes.ok) {
    return NextResponse.json({ error: 'Failed to fetch calendar data' }, { status: 502 });
  }
  const data = await apiRes.text();

  // Build date list: index 0 = Jan 1 of year.
  // UTC-компоненты по всей цепочке (Date.UTC/setUTCDate/getUTCFullYear) —
  // те же, что в lib/plans/dailyPlan.ts::countWeekdaysInclusive. Раньше даты
  // строились локальным временем процесса (Europe/Moscow, UTC+3), а
  // сохранялись через toISOString() (UTC) — полночь 1 января МСК уходила в
  // 31 декабря 21:00 UTC, и весь год в working_calendar сдвигался на сутки
  // (задача 3066).
  const startDate = new Date(Date.UTC(year, 0, 1));
  const rows: { date: string; isWorking: boolean }[] = [];
  for (let i = 0; i < data.length; i++) {
    const d = new Date(startDate);
    d.setUTCDate(startDate.getUTCDate() + i);
    if (d.getUTCFullYear() !== year) break;
    const isWorking = data[i] === '0'; // '0' = working, '1' = non-working
    const dateStr = d.toISOString().slice(0, 10);
    rows.push({ date: dateStr, isWorking });
  }

  // Дешёвая самопроверка перед записью: перекос часового пояса (или любой
  // другой сбой построения дат) должен ловиться здесь, а не всплывать через
  // месяц в метриках плана (см. диагноз задачи 3066). При провале — не
  // трогаем БД и возвращаем ошибку.
  const validationError = validateCalendarRows(year, rows);
  if (validationError) {
    return NextResponse.json(
      { error: `Календарь не сохранён: самопроверка не пройдена — ${validationError}` },
      { status: 422 }
    );
  }

  const db = systemDb();

  // Delete existing rows for this year
  await db.query(
    `DELETE FROM working_calendar WHERE EXTRACT(YEAR FROM date) = $1`,
    [year]
  );

  // Batch insert
  if (rows.length > 0) {
    const values = rows.map((r, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const params = rows.flatMap(r => [r.date, r.isWorking]);
    await db.query(
      `INSERT INTO working_calendar (date, is_working) VALUES ${values}`,
      params
    );
  }

  return NextResponse.json({ inserted: rows.length });
}
