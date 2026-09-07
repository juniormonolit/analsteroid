// Поиск метрик по названию — общий для панели метрик отчёта (MetricPanel) и
// пикера конструктора «Мой отчёт» (жалоба владельца 07.09: в конструкторе поиск
// был по подстроке — «если не символ в символ метрику вводишь, не найдёшь»).
//
// Разделители (стрелки любых видов →←↔, тире/дефис, слэши, скобки, кавычки, знаки
// препинания) заменяются на пробел, лишние пробелы схлопываются — «CR Сделка →
// Бронь» находится по «сделка бронь». Метрика подходит, если ВСЕ токены запроса
// встречаются в нормализованном тексте в любом порядке.

const SEARCH_SEPARATOR_RE = /[←-⇿➔➠-➿‐-―_/,;:()«»"'.\-]+/g;

export function normalizeSearchText(s: string): string {
  return s.toLowerCase().replace(SEARCH_SEPARATOR_RE, ' ').replace(/\s+/g, ' ').trim();
}

export function searchTokens(query: string): string[] {
  return normalizeSearchText(query).split(' ').filter(Boolean);
}

export function matchesSearchTokens(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const normalized = normalizeSearchText(text);
  return tokens.every(t => normalized.includes(t));
}

/** Метрика подходит, если токены находятся в полном имени, коротком имени или категории. */
export function metricMatchesQuery(
  m: { nameRu: string; nameShortRu?: string | null; category?: string | null },
  tokens: string[],
): boolean {
  return matchesSearchTokens(m.nameRu, tokens)
    || matchesSearchTokens(m.nameShortRu ?? '', tokens)
    || matchesSearchTokens(m.category ?? '', tokens);
}
