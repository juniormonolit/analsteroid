import { NextRequest } from 'next/server';
import { bitrixAppEntry, bitrixAppHtml } from '@/lib/bitrix/appEntry';

// Точка входа встроенного в Битрикс приложения (задача владельца 30.07) — пункт «Монолитика» левого
// меню, ведёт в личный кабинет. Механика входа — lib/bitrix/appEntry.ts (общая с «Канбаном повторных»).

export function POST(req: NextRequest) {
  return bitrixAppEntry(req, '/bx/manager', 'Загружаем ваш кабинет…');
}

// Битрикс при проверке обработчика может сходить GET'ом — отвечаем понятным текстом,
// а не 405, чтобы в настройках приложения не выглядело сломанным.
export function GET() {
  return bitrixAppHtml('<p>Это точка входа приложения «Монолитика» для Битрикс24.<br>Откройте её из меню портала.</p>');
}
