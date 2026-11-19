import { NextRequest } from 'next/server';
import { bitrixAppEntry, bitrixAppHtml } from '@/lib/bitrix/appEntry';

// Вход «Канбана логиста» (запросы логистам, 19.11) из Битрикса — по образцу /api/bitrix/app/repeat-kanban:
// AUTH_ID сотрудника → сессия → /bx/logist-kanban → /logist-kanban. Права — как у доски (section.logist_kanban
// или руководитель логистики). Пункт левого меню портала ещё не зарегистрирован — см. BACKLOG.

export function POST(req: NextRequest) {
  return bitrixAppEntry(req, '/bx/logist-kanban', 'Загружаем канбан логиста…');
}

export function GET() {
  return bitrixAppHtml('<p>Это точка входа «Канбана логиста» для Битрикс24.<br>Откройте его из меню портала.</p>');
}
