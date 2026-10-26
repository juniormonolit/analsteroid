import { NextRequest } from 'next/server';
import { bitrixAppEntry, bitrixAppHtml } from '@/lib/bitrix/appEntry';

// Пункт «Канбан повторных» в левом меню Битрикса (владелец 26.10: «канбан открывался по кнопке слева в
// главном меню, и система сама понимала, кто его открыл»). Тот же вход, что у «Монолитики» (ЛК):
// AUTH_ID сотрудника → сессия → /bx/repeat-kanban → /repeat-kanban. Права — как у доски
// (section.repeat_kanban): без права человек увидит «недостаточно прав», а не чужие данные.

export function POST(req: NextRequest) {
  return bitrixAppEntry(req, '/bx/repeat-kanban', 'Загружаем канбан повторных…');
}

export function GET() {
  return bitrixAppHtml('<p>Это точка входа «Канбана повторных продаж» для Битрикс24.<br>Откройте его из меню портала.</p>');
}
