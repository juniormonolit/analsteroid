// iOS splash screens (apple-touch-startup-image, задача 2947, П2.9 плана
// мобильной готовности). Источник данных — public/icons/splash/manifest.json,
// сгенерирован scripts/generate-splash-screens.mjs вместе с самими PNG
// (регенерировать вручную при смене логотипа/списка устройств — см. шапку
// скрипта, тот же паттерн, что generate-pwa-icons.mjs). Next поддерживает
// статический импорт JSON — типизация ниже отражает форму, которую пишет
// генератор.
import splashManifest from '@/public/icons/splash/manifest.json';

export interface AppleSplashLink {
  href: string;
  media: string;
}

export const APPLE_SPLASH_LINKS: AppleSplashLink[] = splashManifest;
