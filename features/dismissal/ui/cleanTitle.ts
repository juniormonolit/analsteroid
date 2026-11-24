// Чистка шума в названиях сделок/задач Битрикса (спека мастера §8):
// • ведущая фраза из ≥2 слов КАПСОМ («ПОСМОТРИ ЗАДАЧУ …») → отдельный серый бейдж;
// • «Сделка (B2B)», «Сделка #123», пустое → «Без названия · #id» (muted).

export interface CleanTitle {
  text: string;
  /** Капс-префикс, вынесенный в бейдж */
  badge: string | null;
  /** Название — заглушка (показывать muted) */
  placeholder: boolean;
}

const PLACEHOLDER_RE = /^(сделка|задача|дело|лид)\s*(\(\s*b2[bc]\s*\)|#\s*\d+|№\s*\d+)?\s*$/i;

export function cleanTitle(raw: string | null | undefined, entityId: number): CleanTitle {
  let text = (raw ?? '').replace(/\s+/g, ' ').trim();
  let badge: string | null = null;
  // Капс-префикс: подряд ≥2 слова целиком заглавными (кириллица/латиница), дальше — обычный текст.
  const m = text.match(/^((?:[A-ZА-ЯЁ]{2,}[\s,.:!—-]+){2,})(.*)$/u);
  // Остаток должен быть «настоящим» текстом (со строчными буквами): «ПОДПИСАТЬ УПД №5» оставляем как есть.
  // Юрформы и аббревиатуры названий компаний («ООО ТД Ромашка») — не шум, их не трогаем.
  if (m && /\p{Ll}/u.test(m[2]) && !/^(ООО|ОАО|ЗАО|ПАО|АО|ИП|ТД|ГК|ЖК|СК|ФГУП|МУП|ГБУ)(?=[\s,.:!—-])/u.test(m[1])) {
    badge = m[1].replace(/[\s,.:!—-]+$/u, '').trim();
    text = m[2].replace(/^[\s,.:!—-]+/u, '').trim();
  }
  if (!text || PLACEHOLDER_RE.test(text)) return { text: `Без названия · #${entityId}`, badge, placeholder: true };
  return { text, badge, placeholder: false };
}
