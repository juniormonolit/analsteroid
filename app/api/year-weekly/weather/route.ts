import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Ручная правка текста погоды в отчёте «Данные по годам» — страховка на случай,
// когда ответственный проигнорировал вопрос бота (живой комментарий обязателен —
// владелец 28.08). Пишет супер-админ; основной путь заполнения — ответ боту.
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const body = await req.json().catch(() => null) as { city?: string; weekStart?: string; text?: string } | null;
  const city = String(body?.city ?? '');
  const weekStart = String(body?.weekStart ?? '');
  const text = String(body?.text ?? '').trim().slice(0, 2000);
  if (!['spb', 'msk', 'krd'].includes(city) || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: 'city (spb|msk|krd) и weekStart (YYYY-MM-DD) обязательны' }, { status: 400 });
  }
  await systemDb().query(
    `INSERT INTO weekly_weather (city, week_start, manual_text, manual_author_bitrix_id, answered_at)
     VALUES ($1, $2, NULLIF($3, ''), $4, CASE WHEN $3 <> '' THEN now() END)
     ON CONFLICT (city, week_start) DO UPDATE SET
       manual_text = NULLIF($3, ''), manual_author_bitrix_id = $4,
       answered_at = CASE WHEN $3 <> '' THEN now() END, updated_at = now()`,
    [city, weekStart, text, session!.bitrixUserId ?? 'admin'],
  );
  return NextResponse.json({ ok: true });
}
