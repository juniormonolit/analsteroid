import { NextRequest, NextResponse } from 'next/server';
import { createSession, SESSION_COOKIE, SESSION_TTL_DAYS } from '@/lib/auth/session';
import { identifyByAuthId, resolveOrCreateAppUser, bitrixPortalOrigin } from '@/lib/bitrix/appAuth';

// Точка входа встроенного в Битрикс приложения (задача владельца 30.07).
// Битрикс открывает этот URL в iframe POST-запросом (form-encoded) и передаёт
// AUTH_ID текущего сотрудника — см. lib/bitrix/appAuth.ts про механику и про то,
// почему портал берём из окружения, а не из тела запроса.
//
// Отдаём не редирект, а маленькую HTML-страницу: cookie ставится этим же ответом,
// а переход на /bx/manager делает браузер уже с ней. Редирект сработал бы тоже, но
// так нам есть куда написать понятный текст, если браузер cookie зарежет.

const PAGE = '/bx/manager';

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

export async function POST(req: NextRequest) {
  const portal = bitrixPortalOrigin();
  if (!portal) {
    console.error('[bitrix/app] не задан BITRIX_PORTAL_URL / BITRIX_WEBHOOK_URL');
    return html('<p>Приложение не настроено: администратору нужно указать адрес портала.</p>', 500);
  }

  // Битрикс шлёт form-encoded; на всякий случай понимаем и JSON.
  let authId = '';
  let placement = '';
  const ctype = req.headers.get('content-type') ?? '';
  try {
    if (ctype.includes('application/json')) {
      const j = await req.json();
      authId = String(j.AUTH_ID ?? j.auth_id ?? '');
      placement = String(j.PLACEMENT ?? '');
    } else {
      const form = await req.formData();
      authId = String(form.get('AUTH_ID') ?? '');
      placement = String(form.get('PLACEMENT') ?? '');
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

  const token = await createSession(resolved.userId);

  const res = html(
    `<p>Загружаем ваш кабинет…</p>`
    + `<script>location.replace(${JSON.stringify(PAGE)});</script>`
    + `<noscript><p><a href="${PAGE}">Открыть кабинет</a></p></noscript>`,
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

// Битрикс при проверке обработчика может сходить GET'ом — отвечаем понятным текстом,
// а не 405, чтобы в настройках приложения не выглядело сломанным.
export function GET() {
  return html('<p>Это точка входа приложения «Монолитика» для Битрикс24.<br>Откройте её из меню портала.</p>');
}
