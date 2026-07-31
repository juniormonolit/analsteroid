import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { buildShelf } from '@/features/badges/engine/shelf';
import { getBalances, getCurrencyName } from '@/features/badges/engine/coins';

// Полка трофеев текущего менеджера (ЛК /manager/me, задача 2655).
// + Баланс валюты и её название (задача 2657).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = systemDb();
  const currencyName = await getCurrencyName(db);
  if (!session.bitrixUserId) return NextResponse.json({ shelf: [], balance: 0, currencyName });

  const id = Number(session.bitrixUserId);
  const [shelf, balances] = await Promise.all([buildShelf(db, id), getBalances(db, [id])]);
  return NextResponse.json({ shelf, balance: balances.get(id) ?? 0, currencyName });
}
