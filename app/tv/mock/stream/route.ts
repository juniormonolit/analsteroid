import { NextResponse } from 'next/server';
import { isTvMock } from '@/features/tv/mock';

// Поток событий телевизора в мок-режиме. Настоящий поток (app/api/tv/stream) слушает
// базу, которой локально нет. Здесь — ответ 204: по стандарту EventSource после него
// перестаёт переподключаться, и страница живёт на обычном опросе фида раз в 15 секунд.
// Вне мок-режима адреса не существует: 404.
export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(null, { status: isTvMock() ? 204 : 404 });
}
