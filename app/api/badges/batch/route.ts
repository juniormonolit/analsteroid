import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { buildShelves } from '@/features/badges/engine/shelf';
import { getBalances, getCurrencyName } from '@/features/badges/engine/coins';
import { fetchXpBriefs } from '@/features/xp/engine/xp';
import { getSessionScope, scopeManagerIds } from '@/lib/org/sessionScope';

// Награды батчем для страницы рейтинга (доп. Серёги 31.07 к 2655): один запрос
// по списку bitrix_id вместо N поштучных /api/badges/me — запрос самого рейтинга
// не трогаем и не утяжеляем. Доступ (аудит 09.09,
// ai_docs/fresh_docs/ACCESS_AUDIT_2026-09-09.md): массив ids режется срезом
// сессии (scopeManagerIds) — чужие просто не возвращаются, без 403: рейтинг
// сам отдаёт строки по тому же срезу, лишние id клиент прислать не должен.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const raw: unknown = body?.bitrixIds;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: 'bitrixIds: number[] обязателен' }, { status: 400 });
  }
  const requestedIds = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  // Аудит 09.09: оставляем только менеджеров из среза сессии (null = админ, без ограничений).
  const allowed = scopeManagerIds(await getSessionScope(session), requestedIds.map(String));
  const ids = allowed === null ? requestedIds : allowed.map(Number);
  const db = systemDb();
  if (ids.length === 0) {
    return NextResponse.json({ shelves: {}, balances: {}, currencyName: await getCurrencyName(db) });
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: 'слишком много id (максимум 500)' }, { status: 400 });
  }

  try {
    // + Балансы валюты и её название (задача 2657) — тем же батчем для /rating.
    // + Уровни XP и топ-классы (миграция 124) — колонка «Уровень» в /rating.
    const [shelves, balances, currencyName, xp] = await Promise.all([
      buildShelves(db, ids),
      getBalances(db, ids),
      getCurrencyName(db),
      fetchXpBriefs(db, ids).catch(() => new Map()),
    ]);
    return NextResponse.json({
      shelves: Object.fromEntries(shelves),
      balances: Object.fromEntries(balances),
      currencyName,
      xp: Object.fromEntries(xp),
    });
  } catch (e) {
    console.error('[badges/batch] failed:', e);
    return NextResponse.json({ error: 'Ошибка загрузки наград' }, { status: 500 });
  }
}
