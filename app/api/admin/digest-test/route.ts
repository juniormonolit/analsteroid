import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { sendDailyDigestForManager, sendWeeklyDigestForManager, fetchActiveManagers } from '@/lib/jobs/managerDigest';

// Ручной триггер дайджеста для живой проверки на проде (задача 2765) — тот же
// паттерн Bearer-токена в обход сессии, что и app/api/admin/org-sync/route.ts:
//   curl -fsS -X POST https://<host>/api/admin/digest-test \
//        -H "Authorization: Bearer $DIGEST_TEST_TOKEN" \
//        -H "Content-Type: application/json" \
//        -d '{"managerBitrixId": 123, "kind": "daily", "deliverTo": 2098}'
// Идёт через тот же sendDailyDigestForManager/sendWeeklyDigestForManager, что и
// боевой прогон — рубильник dry-run и личные настройки подписки применяются
// как обычно (по умолчанию реального отправления НЕ будет, пока dry-run
// включён — сообщение только формируется и логируется в bot_outbound_log).
// deliverTo позволяет посмотреть цифры РЕАЛЬНОГО менеджера, отправив (при
// выключенном dry-run) в чат другого получателя — например владельцу на
// проверку, не тревожа самого менеджера.

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

  const body = await request.json().catch(() => null) as { managerBitrixId?: number; kind?: 'daily' | 'weekly'; deliverTo?: number } | null;
  if (!body?.managerBitrixId || !body.kind) {
    return NextResponse.json({ error: 'Нужны managerBitrixId и kind (daily|weekly)' }, { status: 400 });
  }

  const managers = await fetchActiveManagers();
  const manager = managers.find(m => m.bitrixId === body.managerBitrixId);
  if (!manager) return NextResponse.json({ error: `Активный менеджер с bitrixId=${body.managerBitrixId} не найден` }, { status: 404 });

  try {
    const message = body.kind === 'daily'
      ? await sendDailyDigestForManager(manager, { deliverTo: body.deliverTo })
      : await sendWeeklyDigestForManager(manager, { deliverTo: body.deliverTo });
    return NextResponse.json({ ok: true, manager, message });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
