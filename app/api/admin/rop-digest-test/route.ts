import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { sendDailyDigestForRop, sendWeeklyDigestForRop, fetchActiveRops } from '@/lib/jobs/ropDigest';

// Ручной триггер дайджеста РОПа для живой проверки (задача 2769) — тот же
// паттерн Bearer-токена в обход сессии, что app/api/admin/digest-test/route.ts
// (2765), тот же env DIGEST_TEST_TOKEN (одна категория админ-действия, не
// заводим второй секрет):
//   curl -fsS -X POST https://<host>/api/admin/rop-digest-test \
//        -H "Authorization: Bearer $DIGEST_TEST_TOKEN" \
//        -H "Content-Type: application/json" \
//        -d '{"ropBitrixId": 1990, "kind": "daily", "deliverTo": 2098}'
// Идёт через sendDailyDigestForRop/sendWeeklyDigestForRop — тот же путь, что
// боевой прогон (dry-run/rop_bot_prefs применяются как обычно).

function isValidServiceToken(req: Request): boolean {
  const expected = process.env.DIGEST_TEST_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = match[1];
  const expBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(provided, 'utf8');
  if (expBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expBuf, gotBuf);
}

export async function POST(request: Request) {
  if (!isValidServiceToken(request)) {
    const session = await getSession();
    const denied = superadminError(session);
    if (denied) return denied;
  }

  const body = await request.json().catch(() => null) as { ropBitrixId?: number; kind?: 'daily' | 'weekly'; deliverTo?: number } | null;
  if (!body?.ropBitrixId || !body.kind) {
    return NextResponse.json({ error: 'Нужны ropBitrixId и kind (daily|weekly)' }, { status: 400 });
  }

  const rops = await fetchActiveRops();
  const rop = rops.find(r => r.bitrixId === body.ropBitrixId);
  if (!rop) return NextResponse.json({ error: `РОП с bitrixId=${body.ropBitrixId} не найден (нет прямых подчинённых)` }, { status: 404 });

  try {
    const message = body.kind === 'daily'
      ? await sendDailyDigestForRop(rop, { deliverTo: body.deliverTo })
      : await sendWeeklyDigestForRop(rop, { deliverTo: body.deliverTo });
    return NextResponse.json({ ok: true, rop, message });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
