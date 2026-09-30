// Хуки загрузчика для assert-скриптов, которым нужно вызвать РЕАЛЬНЫЙ route
// handler без БД, cookies() и Битрикса (задача #8256, тесты безопасности).
//
// Поверх обычного резолвера (ts-resolve-hooks.mjs) подменяем по РЕЗОЛВНУТОМУ
// пути несколько модулей-«границ» на заглушки из этой папки — так подмена
// срабатывает и для `@/lib/db/clients`, и для относительного `../db/clients`.
// Сами заглушки держат состояние в globalThis.__stub (см. state.ts), тест
// задаёт сессию и ответы БД перед каждым вызовом ручки.
//
// Подключение: node --import ./scripts/test-stubs/register.mjs scripts/assert-*.ts
import { resolve as baseResolve } from '../ts-resolve-hooks.mjs';

const HERE = new URL('./', import.meta.url).href;
const STUBS = [
  ['/lib/db/clients.ts', 'db.ts'],
  ['/lib/auth/session.ts', 'session.ts'],
  ['/lib/invites/tokens.ts', 'invites.ts'],
  ['/features/badges/engine/notifications.ts', 'notifications.ts'],
  ['/lib/deal-chats/service.ts', 'empty.ts'],
  ['/lib/bot/feedback.ts', 'empty.ts'],
];

export async function resolve(specifier, context, nextResolve) {
  // next/server и next/headers без расширения Node в ESM не находит.
  if (specifier === 'next/server' || specifier === 'next/headers') {
    return nextResolve(specifier + '.js', context);
  }
  const r = await baseResolve(specifier, context, nextResolve);
  const fromStubs = context.parentURL && context.parentURL.startsWith(HERE);
  if (!fromStubs) {
    for (const [suffix, stub] of STUBS) {
      if (r.url.endsWith(suffix)) return { url: HERE + stub, shortCircuit: true };
    }
  }
  return r;
}
