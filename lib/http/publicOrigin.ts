import { NextRequest } from 'next/server';

// В standalone-режиме за Caddy req.nextUrl.origin отражает bind-адрес процесса
// (HOSTNAME/PORT из start.sh, напр. https://0.0.0.0:8100), а не реальный домен —
// Caddy кладёт настоящий хост в X-Forwarded-*, их и используем в первую очередь.
export function getPublicOrigin(req: NextRequest): string {
  const forwardedHost = req.headers.get('x-forwarded-host');
  if (forwardedHost) {
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    return `${proto}://${forwardedHost}`;
  }
  return req.nextUrl.origin;
}
