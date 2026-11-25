import { NextRequest, NextResponse } from 'next/server';
import { createSession, SESSION_COOKIE, SESSION_TTL_DAYS } from '@/lib/auth/session';
import { identifyByAuthId, resolveOrCreateAppUser, bitrixPortalOrigin } from '@/lib/bitrix/appAuth';
import { rememberAppToken } from '@/lib/bitrix/appToken';
import { saveUserTokens } from '@/lib/bitrix/userTokens';
import { mintHandoff } from '@/lib/bitrix/handoff';

// Общий вход из локального приложения Битрикса (вынесено из /api/bitrix/app 26.10, когда появился
// второй пункт левого меню — «Канбан повторных»). Битрикс открывает обработчик в iframe POST-запросом
// (form-encoded) с AUTH_ID текущего сотрудника; мы подтверждаем его у портала (identifyByAuthId — портал
// из окружения, не из тела запроса), находим/создаём аккаунт «Монолитики», заводим сессию и отдаём
// маленькую HTML-страницу: cookie ставится этим ответом, переход на страницу делает браузер уже с ней.
// Если браузер зарежет cookie внутри iframe — у страницы есть одноразовый ключ входа в обычной вкладке.

function html(body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Монолитика</title><style>`
    + `body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;`
    + `color:#1f2328;background:#fff;display:flex;align-items:center;justify-content:center;`
    + `min-height:100vh;padding:24px;text-align:center}a{color:#2f5597}`
    + `</style></head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/** Встройка-вкладка (CRM_*_DETAIL_TAB): после подтверждения сотрудника — проверка контекста и параметры страницы.
 *  Вернуть `{ params }` — пойдут в адрес page (рядом с `t`), `{ error, status }` — показать человеку и не входить. */
export type BitrixEntryPrepare = (p: { authId: string; placement: string; options: Record<string, unknown> })
  => Promise<{ params: Record<string, string> } | { error: string; status: number }>;

/** page — встроенная страница входа (/bx/…), loading — текст «Загружаем …», prepare — для вкладок с PLACEMENT_OPTIONS. */
export async function bitrixAppEntry(req: NextRequest, page: string, loading: string, prepare?: BitrixEntryPrepare): Promise<NextResponse> {
  const portal = bitrixPortalOrigin();
  if (!portal) {
    console.error('[bitrix/app] не задан BITRIX_PORTAL_URL / BITRIX_WEBHOOK_URL');
    return html('<p>Приложение не настроено: администратору нужно указать адрес портала.</p>', 500);
  }

  // Битрикс шлёт form-encoded; на всякий случай понимаем и JSON.
  let authId = '';
  let refreshId = '';
  let authExpires = 3600;
  let placement = '';
  let optionsRaw: unknown = '';
  const ctype = req.headers.get('content-type') ?? '';
  try {
    if (ctype.includes('application/json')) {
      const j = await req.json();
      authId = String(j.AUTH_ID ?? j.auth_id ?? '');
      refreshId = String(j.REFRESH_ID ?? '');
      authExpires = Number(j.AUTH_EXPIRES) || 3600;
      placement = String(j.PLACEMENT ?? '');
      optionsRaw = j.PLACEMENT_OPTIONS ?? '';
    } else {
      const form = await req.formData();
      authId = String(form.get('AUTH_ID') ?? '');
      refreshId = String(form.get('REFRESH_ID') ?? '');
      authExpires = Number(form.get('AUTH_EXPIRES')) || 3600;
      placement = String(form.get('PLACEMENT') ?? '');
      optionsRaw = String(form.get('PLACEMENT_OPTIONS') ?? '');
    }
  } catch {
    return html('<p>Не удалось прочитать запрос от Битрикса.</p>', 400);
  }

  if (!authId) {
    return html('<p>Битрикс не передал токен авторизации. Откройте приложение из меню портала.</p>', 400);
  }

  const identity = await identifyByAuthId(authId);
  if (!identity) {
    console.warn('[bitrix/app] AUTH_ID не подтверждён порталом', { placement });
    return html('<p>Не удалось подтвердить вашу учётную запись на портале. Обновите страницу.</p>', 403);
  }

  let params: Record<string, string> = {};
  if (prepare) {
    let options: Record<string, unknown> = {};
    try {
      const o = typeof optionsRaw === 'string' ? JSON.parse(optionsRaw || '{}') : optionsRaw;
      if (o && typeof o === 'object') options = o as Record<string, unknown>;
    } catch { /* пустые опции — prepare сам скажет, чего не хватает */ }
    const p = await prepare({ authId, placement, options });
    if ('error' in p) return html(`<p>${p.error}</p>`, p.status);
    params = p.params;
  }

  const resolved = await resolveOrCreateAppUser(identity);
  if (!resolved) {
    return html(
      `<p>Ваш аккаунт в «Монолитике» отключён.<br>Обратитесь к администратору.</p>`,
      403,
    );
  }
  if (resolved.created) {
    console.log('[bitrix/app] создан аккаунт для bitrix_user_id', identity.bitrixUserId);
  }

  const token = await createSession(resolved.userId, { via: 'bitrix_iframe', surface: 'bx_iframe' });
  // Токен приложения (17.09): методы placement.* работают только в контексте
  // приложения, вебхуку они недоступны. Запоминаем AUTH_ID на его срок жизни —
  // супер-админ из «Настроек» сможет привязать «Монолитику» в левое меню портала.
  await rememberAppToken(resolved.userId, authId);
  // Токены сотрудника — чтобы задачи из канбана ставились и принимались от ЕГО имени (09.11, userTokens.ts).
  await saveUserTokens(identity.bitrixUserId, authId, refreshId || null, authExpires);

  // Одноразовый ключ на случай, когда браузер зарежет cookie внутри iframe
  // (инцидент 21.09: Яндекс.Браузер/Safari/встроенный webview). Страница
  // /bx/manager по нему предложит открыть кабинет в обычной вкладке, где
  // cookie первосторонняя и работает везде.
  const handoff = await mintHandoff(resolved.userId);
  const qs = new URLSearchParams(params);
  if (handoff) qs.set('t', handoff);
  const target = qs.size ? `${page}?${qs}` : page;

  const res = html(
    `<p>${loading}</p>`
    + `<script>location.replace(${JSON.stringify(target)});</script>`
    + `<noscript><p><a href="${target}">Открыть</a></p></noscript>`,
  );
  // Cookie для iframe: без SameSite=None браузер её в кросс-сайтовом фрейме не пошлёт,
  // а Partitioned (CHIPS) нужен, чтобы Chrome/Safari не зарезали её как третьесторонюю.
  // Обычный вход через /login ставит свою cookie с Lax — тот путь не меняем.
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    partitioned: true,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    path: '/',
  });
  return res;
}

export const bitrixAppHtml = html;
