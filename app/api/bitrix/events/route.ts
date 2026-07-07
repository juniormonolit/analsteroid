import { NextRequest, NextResponse } from 'next/server';

// Обработчик событий бота "Аналитик" (EVENT_MESSAGE_ADD и т.п.), обязателен для
// imbot.register. Пока просто подтверждает получение — разбор вопросов и ответы
// от бота на естественном языке — Phase 2.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') || '';
  const data: Record<string, unknown> = {};

  if (contentType.includes('application/json')) {
    Object.assign(data, await req.json().catch(() => ({})));
  } else {
    const form = await req.formData().catch(() => null);
    if (form) for (const [key, value] of form.entries()) data[key] = String(value);
  }

  console.log('[bitrix/events]', data.event ?? 'unknown event', JSON.stringify(data).slice(0, 500));

  return NextResponse.json({});
}
