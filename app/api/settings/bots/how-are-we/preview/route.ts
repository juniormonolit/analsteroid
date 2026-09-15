import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { buildHowAreWeDigest, fetchHowAreWeSettings, mskNowParts, baseUrl } from '@/lib/jobs/howAreWe';
import { buildHowAreWeDetails } from '@/features/how-are-we/engine/text';

// Пример выпуска на сегодняшних данных с фразами, которые владелец правит прямо
// сейчас (ещё не сохранёнными) — чтобы видеть результат до «Сохранить».
export async function POST(req: Request) {
  const err = superadminError(await getSession());
  if (err) return err;
  const body = await req.json().catch(() => ({})) as { hour?: number; phrases?: Record<string, string[]> };
  const hour = Number.isInteger(body.hour) && body.hour! >= 0 && body.hour! <= 23 ? body.hour! : mskNowParts().hour;
  try {
    const s = await fetchHowAreWeSettings();
    const overrides = body.phrases && typeof body.phrases === 'object' ? body.phrases : s.phrases;
    const built = await buildHowAreWeDigest(mskNowParts().date, hour, s, overrides);
    const details = buildHowAreWeDetails(built.facts, { overrides, hours: s.hours, baseUrl: baseUrl() });
    return NextResponse.json({ message: built.message, details, imageUrl: built.imageUrl, hour });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
