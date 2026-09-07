import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, getUserAgent } from '@/lib/auth/pin';
import { registerDevice } from '@/features/tv/engine/store';
import { rateLimited, tooMany } from '@/features/tv/engine/rateLimit';

// Регистрация телевизора: выдаём токен устройства + код привязки. Публично, но
// с лимитом на IP (5 регистраций в 10 минут): случайные боты не должны плодить
// строки в tv_devices. Непривязанные устройства чистятся через неделю.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (rateLimited(`tv:dev:${ip ?? 'na'}`, 5, 600)) return tooMany();
  const ua = getUserAgent(req);
  const { token, code } = await registerDevice(ua ? ua.slice(0, 300) : null, ip);
  return NextResponse.json({ token, code }, { headers: { 'Cache-Control': 'no-store' } });
}
