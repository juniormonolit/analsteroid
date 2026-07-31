import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { buildShelves } from '@/features/badges/engine/shelf';

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
  if (ids.length === 0) return NextResponse.json({ shelves: {} });
  if (ids.length > 500) {
    return NextResponse.json({ error: 'слишком много id (максимум 500)' }, { status: 400 });
  }

  try {
    const shelves = await buildShelves(systemDb(), ids);
    return NextResponse.json({ shelves: Object.fromEntries(shelves) });
  } catch (e) {
    console.error('[badges/batch] failed:', e);
    return NextResponse.json({ error: 'Ошибка загрузки наград' }, { status: 500 });
  }
}
