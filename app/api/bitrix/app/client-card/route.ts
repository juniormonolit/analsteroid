import { NextRequest, NextResponse } from 'next/server';
import { identifyByAuthId, resolveOrCreateAppUser, bitrixPortalOrigin } from '@/lib/bitrix/appAuth';
import { bxApp, rememberAppToken } from '@/lib/bitrix/appToken';
import { mintWidgetGrant } from '@/lib/bitrix/widgetGrant';

// Вкладка «Карточка клиента» в карточке контакта/компании Битрикса (задача
// владельца 13.10). Битрикс открывает этот URL в iframe POST-запросом:
// AUTH_ID сотрудника, PLACEMENT (CRM_CONTACT_DETAIL_TAB | CRM_COMPANY_DETAIL_TAB)
// и PLACEMENT_OPTIONS = {"ID":"<id сущности>"}.
//
// 1) кто это — identifyByAuthId (портал из окружения, не из тела запроса);
// 2) видит ли он этого клиента — crm.<entity>.get ЕГО токеном (Битрикс отвечает
//    по правам сотрудника; подделать ID в POST и посмотреть чужого не выйдет);
// 3) пропуск виджета на 8 ч (lib/bitrix/widgetGrant.ts) → /bx/client-card.
//
// Вкладка в сделке (CRM_DEAL_DETAIL_TAB, владелец 15.10): клиент сделки —
// компания, если она есть, иначе контакт. Доступ — по самой сделке: кто видит
// сделку, видит и карточку её клиента.

const PAGE = '/bx/client-card';

function html(body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Карточка клиента</title><style>`
    + `body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1f2328;background:#fff;`
    + `display:flex;align-items:center;justify-content:center;min-height:200px;padding:24px;text-align:center}`
    + `</style></head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

const ENTITY: Record<string, 'contact' | 'company' | 'deal'> = {
  CRM_CONTACT_DETAIL_TAB: 'contact',
  CRM_COMPANY_DETAIL_TAB: 'company',
  CRM_DEAL_DETAIL_TAB: 'deal',
};

export async function POST(req: NextRequest) {
  if (!bitrixPortalOrigin()) return html('<p>Приложение не настроено: не задан адрес портала.</p>', 500);

  let authId = '', placement = '', optionsRaw = '';
  try {
    const ctype = req.headers.get('content-type') ?? '';
    if (ctype.includes('application/json')) {
      const j = await req.json();
      authId = String(j.AUTH_ID ?? ''); placement = String(j.PLACEMENT ?? '');
      optionsRaw = typeof j.PLACEMENT_OPTIONS === 'string' ? j.PLACEMENT_OPTIONS : JSON.stringify(j.PLACEMENT_OPTIONS ?? {});
    } else {
      const f = await req.formData();
      authId = String(f.get('AUTH_ID') ?? ''); placement = String(f.get('PLACEMENT') ?? ''); optionsRaw = String(f.get('PLACEMENT_OPTIONS') ?? '');
    }
  } catch {
    return html('<p>Не удалось прочитать запрос от Битрикса.</p>', 400);
  }

  const entity = ENTITY[placement];
  let entityId = '';
  try { entityId = String((JSON.parse(optionsRaw || '{}') as { ID?: unknown }).ID ?? ''); } catch { /* ниже — «нет ID» */ }
  if (!entity || !/^\d{1,12}$/.test(entityId)) {
    return html('<p>Эта вкладка работает в карточке контакта, компании или сделки.</p>', 400);
  }
  if (!authId) return html('<p>Битрикс не передал токен авторизации. Обновите карточку.</p>', 400);

  const identity = await identifyByAuthId(authId);
  if (!identity) return html('<p>Не удалось подтвердить вашу учётную запись на портале. Обновите карточку.</p>', 403);

  const check = await bxApp<{ CONTACT_ID?: string | null; COMPANY_ID?: string | null }>(authId, `crm.${entity}.get`, { id: Number(entityId) });
  if (!check.ok) {
    console.warn('[bitrix/client-card] нет доступа к клиенту', { entity, entityId, user: identity.bitrixUserId, error: check.error });
    const scope = /scope/i.test(check.error);
    return html(scope
      ? '<p>У приложения «Монолитика» нет права на CRM. Администратору портала: добавьте приложению право «CRM» и переустановите его.</p>'
      : `<p>${entity === 'deal' ? 'Эта сделка' : 'Этот клиент'} вам недоступен в Битриксе.</p>`, 403);
  }

  // Сделка → её клиент.
  let client: { entity: 'contact' | 'company'; id: number };
  if (entity === 'deal') {
    const company = Number(check.result?.COMPANY_ID ?? 0), contact = Number(check.result?.CONTACT_ID ?? 0);
    if (company > 0) client = { entity: 'company', id: company };
    else if (contact > 0) client = { entity: 'contact', id: contact };
    else return html('<p>В сделке не указан клиент (контакт или компания).</p>');
  } else {
    client = { entity, id: Number(entityId) };
  }

  const resolved = await resolveOrCreateAppUser(identity);
  if (!resolved) return html('<p>Ваш аккаунт в «Монолитике» отключён. Обратитесь к администратору.</p>', 403);
  await rememberAppToken(resolved.userId, authId);

  const ref = `${client.entity === 'company' ? 'k' : 'c'}${client.id}`;
  const token = await mintWidgetGrant({ userId: resolved.userId, actor: identity.name, ref });
  if (!token) return html('<p>Сервис временно недоступен (хранилище пропусков). Обновите карточку через минуту.</p>', 503);

  const target = `${PAGE}?${client.entity === 'company' ? 'companyId' : 'contactId'}=${client.id}&w=${encodeURIComponent(token)}`;
  return html(
    `<p>Загружаем карточку клиента…</p><script>location.replace(${JSON.stringify(target)});</script>`
    + `<noscript><p><a href="${target}">Открыть</a></p></noscript>`,
  );
}

export function GET() {
  return html('<p>Это вкладка «Карточка клиента» приложения «Монолитика» для карточки контакта, компании или сделки Битрикс24.</p>');
}
