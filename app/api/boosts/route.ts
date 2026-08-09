import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { activateBoost, fetchMyBoosts } from '@/features/badges/engine/boosts';
import { getManagerScopes } from '@/features/badges/engine/orgScopes';

// Бусты (задача 51): что сейчас активно и активация купленного из инвентаря.
// Буст множит ТОЛЬКО XP — денежных ручек здесь нет и быть не должно.

async function ctx() {
  const session = await getSession();
  if (!session?.bitrixUserId) return null;
  const mgr = Number(session.bitrixUserId);
  if (!Number.isFinite(mgr) || mgr <= 0) return null;
  const deptKey = (await getManagerScopes()).get(mgr)?.deptKey ?? null;
  return { mgr, deptKey };
}

export async function GET() {
  const c = await ctx();
  if (!c) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ boosts: await fetchMyBoosts(systemDb(), c.mgr, c.deptKey) });
}

export async function POST(req: Request) {
  const c = await ctx();
  if (!c) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const id = Number(body.inventoryItemId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Не указан предмет' }, { status: 400 });
  // Активируем ТОЛЬКО свой предмет — проверка внутри движка идёт по bitrix_id.
  const res = await activateBoost(systemDb(), c.mgr, id, c.deptKey);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res);
}
