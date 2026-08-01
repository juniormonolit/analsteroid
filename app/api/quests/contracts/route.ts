import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { takeContract } from '@/features/quests/engine/contracts';

// Взять контракт с доски (миграция 126): депозит списывается с кошелька СЕССИИ,
// лимит активных и кулдаун после провала проверяет движок.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });
  let body: { contractId?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 }); }
  const id = Number(body.contractId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'contractId обязателен' }, { status: 400 });
  const res = await takeContract(systemDb(), Number(session.bitrixUserId), id, session.login);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, contract: res.contract });
}
