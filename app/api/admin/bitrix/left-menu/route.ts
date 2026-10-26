import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { getAppToken, bxApp } from '@/lib/bitrix/appToken';

// «Монолитика» в левом меню Битрикса для всех сотрудников (задача владельца 17.09).
// placement.* доступны только в контексте приложения, поэтому нужен токен из
// открытия приложения (см. lib/bitrix/appToken.ts): супер-админ открывает
// «Монолитику» внутри Битрикса, потом здесь жмёт «Добавить». GET — что привязано,
// POST — привязать LEFT_MENU, DELETE — отвязать. 26.10 — второй пункт «Канбан повторных» (?target=repeat-kanban):
// свой обработчик /api/bitrix/app/repeat-kanban, вход тот же (lib/bitrix/appEntry.ts).

const BASE = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.com').replace(/\/$/, '');
const TARGETS = {
  profile: { path: '/api/bitrix/app', title: 'Монолитика', description: 'Личный кабинет: мои заказчики, статистика, отчёт' },
  'repeat-kanban': { path: '/api/bitrix/app/repeat-kanban', title: 'Канбан повторных', description: 'Канбан повторных продаж: заказчики, задачи, приёмка' },
} as const;
type Target = keyof typeof TARGETS;
const targetOf = (req: NextRequest): Target => (req.nextUrl.searchParams.get('target') === 'repeat-kanban' ? 'repeat-kanban' : 'profile');
const HANDLER = (t: Target = 'profile') => `${BASE()}${TARGETS[t].path}`;

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
  return NextResponse.json({ hasToken: true, bindings: r.result ?? [], handler: HANDLER(), handlers: { profile: HANDLER('profile'), 'repeat-kanban': HANDLER('repeat-kanban') } });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session); if (err) return err;
  const token = await tokenOr401(session!.id);
  if (!token) return NextResponse.json({ error: NO_TOKEN }, { status: 409 });
  const t = TARGETS[targetOf(req)];
  const r = await bxApp(token, 'placement.bind', {
    PLACEMENT: 'LEFT_MENU',
    HANDLER: HANDLER(targetOf(req)),
    TITLE: t.title,
    DESCRIPTION: t.description,
    LANG_ALL: { ru: { TITLE: t.title, DESCRIPTION: t.description } },
  });
  if (!r.ok) return NextResponse.json({ error: `${r.error}: ${r.description}` }, { status: 502 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session); if (err) return err;
  const token = await tokenOr401(session!.id);
  if (!token) return NextResponse.json({ error: NO_TOKEN }, { status: 409 });
  const r = await bxApp(token, 'placement.unbind', { PLACEMENT: 'LEFT_MENU', HANDLER: HANDLER(targetOf(req)) });
  if (!r.ok) return NextResponse.json({ error: `${r.error}: ${r.description}` }, { status: 502 });
  return NextResponse.json({ ok: true, result: r.result });
}
