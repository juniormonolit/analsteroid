// IP клиента для лимитов (аудит безопасности 29.09, #8256, находка A4).
//
// Прод и дев стоят за Caddy на том же хосте (reverse_proxy на 127.0.0.1). Caddy
// ДОПИСЫВАЕТ адрес, с которого к нему пришли, в КОНЕЦ X-Forwarded-For (или
// заменяет заголовок целиком, если клиент не из trusted_proxies). Всё, что левее,
// прислал сам клиент и может быть подделано. Поэтому доверяем только адресу,
// который добавил наш прокси: N-й справа, N = TRUSTED_PROXY_HOPS (по умолчанию
// 1 — один Caddy). Раньше брался левый адрес — любой обходил IP-лимиты, подставив
// свой X-Forwarded-For.
//
// Ограничение: при прямом доступе к порту приложения в обход Caddy заголовок
// целиком от клиента — порт приложения должен слушать только 127.0.0.1 (зона
// Артёма, #8257).
export function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

export function clientIpFromHeaders(headers: Headers, hops = trustedProxyHops()): string | null {
  const xff = headers.get('x-forwarded-for');
  if (!xff) return null;
  const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  // Цепочка короче числа доверенных прокси — берём самый левый из имеющихся.
  const ip = parts[Math.max(0, parts.length - hops)];
  return ip && ip.length <= 64 ? ip : null;
}
