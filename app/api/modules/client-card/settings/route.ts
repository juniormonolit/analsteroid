import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { getActiveDays, setActiveDays } from '@/features/client-module/engine/clientModule';

// Настройки модуля «Карточка клиента» (Настройки → Карточка клиента): N — сколько
// дней после последней отгрузки объект считается «В работе» (решение владельца
// 13.10, по умолчанию 90). Хранится в sa.client_module_settings (миграция 006).
export async function GET() {
  const session = await getSession();
  const err = superadminError(session); if (err) return err;
  return NextResponse.json(await getActiveDays());
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session); if (err) return err;
  const body = await req.json().catch(() => null) as { days?: unknown } | null;
  const days = Number(body?.days);
  if (!Number.isInteger(days) || days < 7 || days > 730) return NextResponse.json({ error: 'N — целое число дней от 7 до 730' }, { status: 400 });
  try {
    await setActiveDays(days, session!.login);
  } catch (e) {
    const notReady = e instanceof Error && /does not exist|permission denied/i.test(e.message);
    return NextResponse.json({ error: notReady ? 'Настройка станет доступна после миграции sa_org/006' : 'Не удалось сохранить' }, { status: notReady ? 503 : 500 });
  }
  return NextResponse.json({ ok: true, days });
}
