// Регистрация резолвера расширений (см. ts-resolve-hooks.mjs).
// Отдельным файлом, потому что module.register() должен вызываться из главного
// потока, а сами хуки исполняются в отдельном.
import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
