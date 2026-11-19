import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { getAppToken, bxApp, unbindStaleHandlers } from '@/lib/bitrix/appToken';

// Вкладка «Запросы логисту» в карточке сделки Битрикса (владелец 19.11). Тот же механизм, что у «Карточки клиента»
// (app/api/admin/bitrix/client-card-tab): placement.* — только в контексте приложения, нужен токен из открытия
// «Монолитики» внутри Битрикса (живёт ~час). Супер-админ, кнопка — «Настройки» (LogistDealTabBlock).
// GET — привязана ли, POST — привязать, DELETE — отвязать. Обработчик — /api/bitrix/app/deal-requests.

const HANDLER = () => `${(process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '')}/api/bitrix/app/deal-requests`;
const PLACEMENT = 'CRM_DEAL_DETAIL_TAB';
const TITLE = 'Запросы логисту';
const DESCRIPTION = 'Запросы логистам по сделке: статусы, варианты, чат, новый запрос с товарами сделки';
const NO_TOKEN = 'Нет токена приложения: откройте «Монолитику» внутри Битрикса под своим аккаунтом (любой пункт), затем вернитесь сюда — токен живёт около часа.';

async function ctx() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return { err, token: null };
  return { err: null, token: await getAppToken(session!.id) };
}

export async function GET() {
  const { err, token } = await ctx(); if (err) return err;
  if (!token) return NextResponse.json({ hasToken: false, bound: false, handler: HANDLER(), hint: NO_TOKEN });
  const r = await bxApp<{ placement: string; handler: string }[]>(token, 'placement.get');
  if (!r.ok) return NextResponse.json({ hasToken: true, bound: false, handler: HANDLER(), error: `${r.error}: ${r.description}` });
  const h = HANDLER();
  return NextResponse.json({ hasToken: true, handler: h, bound: (r.result ?? []).some(b => b.placement === PLACEMENT && b.handler === h) });
}

export async function POST() {
  const { err, token } = await ctx(); if (err) return err;
  if (!token) return NextResponse.json({ error: NO_TOKEN }, { status: 409 });
  const r = await bxApp(token, 'placement.bind', {
    PLACEMENT, HANDLER: HANDLER(), TITLE, DESCRIPTION, LANG_ALL: { ru: { TITLE, DESCRIPTION } },
  });
  // Повторная привязка того же обработчика — не ошибка.
  if (!r.ok && !/already|HANDLER_ALREADY_BINDED/i.test(`${r.error} ${r.description}`)) {
    return NextResponse.json({ error: `${r.error} ${r.description}`.trim() }, { status: 502 });
  }
  const removed = await unbindStaleHandlers(token, [PLACEMENT], HANDLER());
  return NextResponse.json({ ok: true, removed });
}

export async function DELETE() {
  const { err, token } = await ctx(); if (err) return err;
  if (!token) return NextResponse.json({ error: NO_TOKEN }, { status: 409 });
  const r = await bxApp(token, 'placement.unbind', { PLACEMENT, HANDLER: HANDLER() });
  if (!r.ok) return NextResponse.json({ error: `${r.error} ${r.description}`.trim() }, { status: 502 });
  return NextResponse.json({ ok: true });
}
