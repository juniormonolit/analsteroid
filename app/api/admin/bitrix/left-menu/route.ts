import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { getAppToken, bxApp } from '@/lib/bitrix/appToken';

// «Монолитика» в левом меню Битрикса для всех сотрудников (задача владельца 17.09).
// placement.* доступны только в контексте приложения, поэтому нужен токен из
// открытия приложения (см. lib/bitrix/appToken.ts): супер-админ открывает
// «Монолитику» внутри Битрикса, потом здесь жмёт «Добавить». GET — что привязано,
// POST — привязать LEFT_MENU, DELETE — отвязать.

const HANDLER = () => `${(process.env.APP_BASE_URL || 'https://monolitika.mlt-it.com').replace(/\/$/, '')}/api/bitrix/app`;

async function tokenOr401(userId: string) {
  const token = await getAppToken(userId);
  return token;
}
const NO_TOKEN = 'Нет токена приложения: откройте «Монолитику» внутри Битрикса под своим аккаунтом (любой пункт), затем вернитесь сюда — токен живёт около часа.';

export async function GET() {
  const session = await getSession();
  const err = superadminError(session); if (err) return err;
  const token = await tokenOr401(session!.id);
  if (!token) return NextResponse.json({ hasToken: false, bindings: [], hint: NO_TOKEN });
  const r = await bxApp<{ placement: string; handler: string; title?: string }[]>(token, 'placement.get');
  if (!r.ok) return NextResponse.json({ hasToken: true, bindings: [], error: `${r.error}: ${r.description}` });
  return NextResponse.json({ hasToken: true, bindings: r.result ?? [], handler: HANDLER() });
}

export async function POST() {
  const session = await getSession();
  const err = superadminError(session); if (err) return err;
  const token = await tokenOr401(session!.id);
  if (!token) return NextResponse.json({ error: NO_TOKEN }, { status: 409 });
  const r = await bxApp(token, 'placement.bind', {
    PLACEMENT: 'LEFT_MENU',
    HANDLER: HANDLER(),
    TITLE: 'Монолитика',
    DESCRIPTION: 'Личный кабинет: мои заказчики, статистика, отчёт',
    LANG_ALL: { ru: { TITLE: 'Монолитика', DESCRIPTION: 'Личный кабинет: мои заказчики, статистика, отчёт' } },
  });
  if (!r.ok) return NextResponse.json({ error: `${r.error}: ${r.description}` }, { status: 502 });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const session = await getSession();
  const err = superadminError(session); if (err) return err;
  const token = await tokenOr401(session!.id);
  if (!token) return NextResponse.json({ error: NO_TOKEN }, { status: 409 });
  const r = await bxApp(token, 'placement.unbind', { PLACEMENT: 'LEFT_MENU', HANDLER: HANDLER() });
  if (!r.ok) return NextResponse.json({ error: `${r.error}: ${r.description}` }, { status: 502 });
  return NextResponse.json({ ok: true, result: r.result });
}
