'use client';
// fetch для виджетов, встроенных в Битрикс: внутри iframe cookie сессии может не
// быть (браузер режет третьесторонние cookie), поэтому виджет ходит в API с
// пропуском из адреса страницы (lib/bitrix/widgetGrant.ts). В обычной Монолитике
// пропуска нет — работает сессия, как раньше.
let widgetToken: string | null = null;

export function setWidgetToken(token: string | null): void { widgetToken = token; }

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!widgetToken) return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set('X-Widget-Token', widgetToken);
  return fetch(input, { ...init, headers });
}
