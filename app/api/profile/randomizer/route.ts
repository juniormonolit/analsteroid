import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import {
  fetchMyGenerated, loadRandomizerSettings, pinCosmetic, rollCosmetic,
} from '@/features/profile/engine/randomizer';
import type { GenKind } from '@/lib/profile/generated';

// Рандомайзер косметики (задача 63, п.1). Крутить и закреплять — только себе:
// операция списывает MLT с кошелька сессии.

const KINDS: GenKind[] = ['frame', 'background', 'cover'];

async function selfId() {
  const session = await getSession();
  if (!session?.bitrixUserId) return null;
  const n = Number(session.bitrixUserId);
  return Number.isFinite(n) && n > 0 ? { mgr: n, login: session.login } : null;
}

export async function GET() {
  const me = await selfId();
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = systemDb();
  const [settings, rows] = await Promise.all([loadRandomizerSettings(db), fetchMyGenerated(db, me.mgr)]);
  return NextResponse.json({ settings, generated: rows });
}

export async function POST(req: Request) {
  const me = await selfId();
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  if (body.action === 'pin') {
    const id = String(body.cosmeticId ?? '');
    if (!id) return NextResponse.json({ error: 'Не указан вариант' }, { status: 400 });
    const res = await pinCosmetic(systemDb(), me.mgr, id, me.login);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json(res);
  }

  const kind = String(body.kind ?? '') as GenKind;
  if (!KINDS.includes(kind)) return NextResponse.json({ error: 'Неизвестный вид косметики' }, { status: 400 });
  const res = await rollCosmetic(systemDb(), me.mgr, kind, me.login);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res);
}
