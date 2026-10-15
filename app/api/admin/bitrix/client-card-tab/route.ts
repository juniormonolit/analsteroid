import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { getAppToken, bxApp } from '@/lib/bitrix/appToken';

// Вкладка «Карточка клиента» в карточках контакта и компании Битрикса (задача
// владельца 13.10). Тот же механизм, что у пункта в левом меню
// (app/api/admin/bitrix/left-menu): placement.* — только в контексте приложения,
// нужен токен из открытия «Монолитики» внутри Битрикса (живёт ~час).
// GET — что привязано, POST — привязать все вкладки, DELETE — отвязать.

const HANDLER = () => `${(process.env.APP_BASE_URL || 'https://monolitika.mlt-it.com').replace(/\/$/, '')}/api/bitrix/app/client-card`;
// Сделка (владелец 15.10) — карточка клиента этой сделки.
const PLACEMENTS = ['CRM_CONTACT_DETAIL_TAB', 'CRM_COMPANY_DETAIL_TAB', 'CRM_DEAL_DETAIL_TAB'] as const;
const TITLE = 'Карточка клиента';
const DESCRIPTION = 'Отгрузки, LTV, средний чек, цикл повторки, товарные группы и объекты клиента';
const NO_TOKEN = 'Нет токена приложения: откройте «Монолитику» внутри Битрикса под своим аккаунтом (любой пункт), затем вернитесь сюда — токен живёт около часа.';

async function ctx() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return { err, token: null };
  return { err: null, token: await getAppToken(session!.id) };
}

export async function GET() {
  const { err, token } = await ctx(); if (err) return err;
  if (!token) return NextResponse.json({ hasToken: false, bound: [], hint: NO_TOKEN });
  const r = await bxApp<{ placement: string; handler: string }[]>(token, 'placement.get');
  if (!r.ok) return NextResponse.json({ hasToken: true, bound: [], error: `${r.error}: ${r.description}` });
  const h = HANDLER();
  return NextResponse.json({ hasToken: true, bound: (r.result ?? []).filter(b => b.handler === h).map(b => b.placement) });
}

export async function POST() {
  const { err, token } = await ctx(); if (err) return err;
  if (!token) return NextResponse.json({ error: NO_TOKEN }, { status: 409 });
  const errors: string[] = [];
  for (const placement of PLACEMENTS) {
    const r = await bxApp(token, 'placement.bind', {
      PLACEMENT: placement, HANDLER: HANDLER(), TITLE, DESCRIPTION,
      LANG_ALL: { ru: { TITLE, DESCRIPTION } },
    });
    // Повторная привязка того же обработчика — не ошибка.
    if (!r.ok && !/already|HANDLER_ALREADY_BINDED/i.test(`${r.error} ${r.description}`)) errors.push(`${placement}: ${r.error} ${r.description}`.trim());
  }
  if (errors.length) return NextResponse.json({ error: errors.join('; ') }, { status: 502 });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const { err, token } = await ctx(); if (err) return err;
  if (!token) return NextResponse.json({ error: NO_TOKEN }, { status: 409 });
  for (const placement of PLACEMENTS) await bxApp(token, 'placement.unbind', { PLACEMENT: placement, HANDLER: HANDLER() });
  return NextResponse.json({ ok: true });
}
