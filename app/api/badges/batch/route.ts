import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { buildShelves } from '@/features/badges/engine/shelf';
import { getBalances, getCurrencyName } from '@/features/badges/engine/coins';

// Награды батчем для страницы рейтинга (доп. Серёги 31.07 к 2655): один запрос
// по списку bitrix_id вместо N поштучных /api/badges/me — запрос самого рейтинга
// не трогаем и не утяжеляем. Доступ: любой залогиненный (рейтинг уже виден
// менеджерам; награды там — публичная мотивация, только позитив, без цифр продаж).
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const raw: unknown = body?.bitrixIds;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: 'bitrixIds: number[] обязателен' }, { status: 400 });
  }
  const ids = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const db = systemDb();
  if (ids.length === 0) {
    return NextResponse.json({ shelves: {}, balances: {}, currencyName: await getCurrencyName(db) });
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: 'слишком много id (максимум 500)' }, { status: 400 });
  }

  try {
    // + Балансы валюты и её название (задача 2657) — тем же батчем для /rating.
    const [shelves, balances, currencyName] = await Promise.all([
      buildShelves(db, ids),
      getBalances(db, ids),
      getCurrencyName(db),
    ]);
    return NextResponse.json({
      shelves: Object.fromEntries(shelves),
      balances: Object.fromEntries(balances),
      currencyName,
    });
  } catch (e) {
    console.error('[badges/batch] failed:', e);
    return NextResponse.json({ error: 'Ошибка загрузки наград' }, { status: 500 });
  }
}
