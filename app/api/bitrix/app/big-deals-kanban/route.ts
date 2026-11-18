import { NextRequest } from 'next/server';
import { bitrixAppEntry, bitrixAppHtml } from '@/lib/bitrix/appEntry';

// Вход «Канбана больших чеков» из Битрикса (18.11, по образцу /api/bitrix/app/repeat-kanban):
// AUTH_ID сотрудника → сессия → /bx/big-deals-kanban → /big-deals-kanban. Права — section.repeat_kanban.
// Пункт левого меню портала ещё не зарегистрирован (BitrixLeftMenuBlock) — см. BACKLOG.

export function POST(req: NextRequest) {
  return bitrixAppEntry(req, '/bx/big-deals-kanban', 'Загружаем канбан больших чеков…');
}

export function GET() {
  return bitrixAppHtml('<p>Это точка входа «Канбана больших чеков» для Битрикс24.<br>Откройте его из меню портала.</p>');
}
