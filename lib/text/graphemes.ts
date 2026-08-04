// Грамема-безопасная работа с текстом (задача 2994): эмодзи-поле конструктора
// товаров должно принимать флаги (2 code point региональных индикаторов),
// эмодзи с тоном кожи (база + модификатор U+1F3FB..FF) и ZWJ-последовательности
// («семья» 👨‍👩‍👧‍👦, флаг ЛГБТ 🏳️‍🌈 и т.п.) — всё это ОДИН пользовательский
// символ (графема), но МНОГО code unit'ов в JS string.length/slice(). Наивная
// truncation по .length режет такие последовательности пополам (остаётся
// сиротский ZWJ/модификатор — рендерится как "квадратик"+обрубок).
//
// Intl.Segmenter(granularity:'grapheme') — стандартный (Unicode UAX #29) способ
// бить строку на графемы, а не code unit'ы; в Node 20+/Chrome 90+ есть из
// коробки, без зависимостей. Используется и на клиенте (ItemEditor), и на
// сервере (валидация в app/api/settings/badges/shop/route.ts) — ОДНА и та же
// функция, чтобы клиентское превью совпадало с тем, что реально сохранится.

let segmenter: Intl.Segmenter | null | undefined;
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;
  return segmenter;
}

/** Строка → массив графем (напр. "👨‍👩‍👧‍👦🔥" → ["👨‍👩‍👧‍👦", "🔥"]). */
export function graphemeClusters(str: string): string[] {
  const seg = getSegmenter();
  if (seg) return Array.from(seg.segment(str), (s) => s.segment);
  // Фолбэк без Intl.Segmenter (не должен случаться в нашем рантайме, но на
  // всякий случай) — Array.from(str) хотя бы не режет отдельные code point
  // (суррогатные пары), просто не склеивает ZWJ-последовательности в одну
  // графему. Лучше, чем str.split('') / str.slice().
  return Array.from(str);
}

/** Число графем в строке (НЕ str.length — тот считает UTF-16 code unit'ы). */
export function graphemeCount(str: string): number {
  return graphemeClusters(str).length;
}

/** Первые N графем строки, БЕЗ разрезания графемы пополам. */
export function firstGraphemes(str: string, n: number): string {
  return graphemeClusters(str).slice(0, n).join('');
}
