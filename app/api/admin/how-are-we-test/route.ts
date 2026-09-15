import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { sendHowAreWe, buildHowAreWeDigest, mskNowParts } from '@/lib/jobs/howAreWe';

// Ручной запуск дайджеста «Как дела?» — тот же Bearer DIGEST_TEST_TOKEN, что у
// digest-test / rop-digest-test (одна категория админ-действия), либо супер-админ:
//   curl -fsS -X POST https://<host>/api/admin/how-are-we-test \
//        -H "Authorization: Bearer $DIGEST_TEST_TOKEN" -H "Content-Type: application/json" \
//        -d '{"hour": 15, "deliverTo": "2098"}'
// dryRun: true — только собрать текст, никуда не слать.

function isValidServiceToken(req: Request): boolean {
  const expected = process.env.DIGEST_TEST_TOKEN;
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!match) return false;
  const a = Buffer.from(expected, 'utf8'); const b = Buffer.from(match[1], 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!isValidServiceToken(request)) {
    const denied = superadminError(await getSession());
    if (denied) return denied;
  }
  const body = await request.json().catch(() => null) as { hour?: number; date?: string; deliverTo?: string | number; dryRun?: boolean } | null;
  const hour = Number(body?.hour ?? mskNowParts().hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return NextResponse.json({ error: 'hour — целое 0..23' }, { status: 400 });
  const date = body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined;
  try {
    if (body?.dryRun) {
      const built = await buildHowAreWeDigest(date ?? mskNowParts().date, hour);
      return NextResponse.json({ ok: true, dryRun: true, message: built.message, imageUrl: built.imageUrl });
    }
    const deliverTo = body?.deliverTo != null ? String(body.deliverTo) : undefined;
    if (deliverTo && !/^\d+$/.test(deliverTo)) return NextResponse.json({ error: 'deliverTo — bitrix id' }, { status: 400 });
    const res = await sendHowAreWe({ cutHour: hour, dateStr: date, deliverTo, test: !!deliverTo });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
