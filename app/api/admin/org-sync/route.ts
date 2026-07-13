import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { runOrgSync } from '@/lib/org/sync';

// Кнопка «Синхронизировать оргструктуру» (задача Серёги 13.07) и ночной cron
// 04:00 МСК дёргают этот роут. Тянет департаменты + сотрудников из Битрикса
// (BITRIX_ORG_WEBHOOK) в схему sa.
//
// Два пути авторизации:
//   1. Админ-сессия (кнопка в UI) — cookie as_session + право action.users.manage.
//   2. Служебный токен (cron, у сессии нет) — заголовок
//      `Authorization: Bearer <ORG_SYNC_TOKEN>`, где значение = env ORG_SYNC_TOKEN.
//      Пример для крона:
//        curl -fsS -X POST https://<host>/api/admin/org-sync \
//             -H "Authorization: Bearer $ORG_SYNC_TOKEN"
//      Если ORG_SYNC_TOKEN не задан/пуст — служебный путь закрыт (только сессия).

// Constant-time сравнение Bearer-токена с ORG_SYNC_TOKEN. Возвращает false, если
// env-переменная не задана/пуста или токен не совпал (в т.ч. по длине), чтобы
// пустой ORG_SYNC_TOKEN никогда не открывал доступ.
function isValidServiceToken(req: Request): boolean {
  const expected = process.env.ORG_SYNC_TOKEN;
  if (!expected) return false; // не задан или пустая строка — служебный путь закрыт

  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = match[1];

  const expBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(provided, 'utf8');
  // timingSafeEqual требует одинаковую длину — иначе бросает. Сравниваем длину
  // отдельно (утечка длины ожидаемого токена несущественна для секрета).
  if (expBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expBuf, gotBuf);
}

export async function POST(request: Request) {
  // Служебный путь для крона: валидный Bearer-токен пропускает в обход сессии.
  if (!isValidServiceToken(request)) {
    // Иначе — обычная авторизация админ-сессией (кнопка в UI).
    const session = await getSession();
    const denied = permError(session, 'action.users.manage');
    if (denied) return denied;
  }

  try {
    const result = await runOrgSync();
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Не удалось синхронизировать оргструктуру';
    console.error('[org-sync] failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
