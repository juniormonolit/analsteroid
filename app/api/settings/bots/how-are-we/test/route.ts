import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { sendHowAreWe, mskNowParts } from '@/lib/jobs/howAreWe';

// «Отправить пробное мне»: выпуск за выбранный час — только в личку текущего
// супер-админа (его bitrix id из аккаунта), получатели из настроек не трогаются.
export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  if (!session!.bitrixUserId) return NextResponse.json({ error: 'У вашего аккаунта не привязан Bitrix ID — некому слать' }, { status: 400 });
  const body = await req.json().catch(() => ({})) as { hour?: number };
  const hour = Number.isInteger(body.hour) && body.hour! >= 0 && body.hour! <= 23 ? body.hour! : mskNowParts().hour;
  try {
    const res = await sendHowAreWe({ cutHour: hour, deliverTo: session!.bitrixUserId, test: true });
    return NextResponse.json({ ok: true, to: session!.bitrixUserId, imageUrl: res.imageUrl });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
