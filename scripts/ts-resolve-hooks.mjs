// Резолвер расширений для assert-скриптов, запускаемых напрямую через Node
// (type-stripping, без сборки).
//
// Проблема: код приложения импортирует соседние модули БЕЗ расширения
// (`./format`) — так требует Next и `moduleResolution: bundler`. Node в ESM
// расширения не угадывает, а прописать `./format.ts` в исходниках нельзя:
// это включает `allowImportingTsExtensions` на весь проект.
//
// Хук доклеивает `.ts` / `.tsx` / `/index.ts` только когда обычный резолв уже
// не справился — то есть ничего не ломает и работает лишь под assert-скриптами.
//
// Подключение: node --import ./scripts/ts-resolve-register.mjs scripts/assert-*.ts

const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Алиас `@/*` из tsconfig — корень проекта. */
const ROOT = new URL('../', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return resolve(ROOT + specifier.slice(2), context, nextResolve);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) throw err;
    for (const ext of CANDIDATES) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        // пробуем следующий кандидат
      }
    }
    throw err;
  }
}
