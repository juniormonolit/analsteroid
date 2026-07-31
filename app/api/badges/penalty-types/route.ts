import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';

// Публичный справочник штрафов (доп. Серёги 31.07): любой залогиненный менеджер
// видит «за что и сколько» — только чтение, только включённые. Прогрессивные
// причины показываются как «X% от баланса».
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = systemDb();
  const [types, currencyName] = await Promise.all([
    db.query<{ id: number; name: string; price: number; price_mode: string }>(
      `SELECT id, name, price, price_mode FROM penalty_types WHERE enabled ORDER BY name`,
    ),
    getCurrencyName(db),
  ]);
  return NextResponse.json({
    currencyName,
    types: types.rows.map(t => ({ id: Number(t.id), name: t.name, price: t.price, priceMode: t.price_mode })),
  });
}
