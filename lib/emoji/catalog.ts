// Полный каталог эмодзи для пикера конструктора товаров (задача 2994, правка
// владельца: «так мало эмодзи, а можно полный список с поиском?»). Источник —
// unicode-emoji-json (MIT, 0 зависимостей, данные unicode.org) вместо тяжёлого
// emoji-mart/emoji-picker-react — просто JSON-датасет 1914 эмодзи с англ.
// названием, картинок не тащит (рендер — системным эмодзи-шрифтом браузера,
// как и раньше).
'use client';

import byEmojiRaw from 'unicode-emoji-json/data-by-emoji.json';
import orderedRaw from 'unicode-emoji-json/data-ordered-emoji.json';

export interface EmojiEntry {
  emoji: string;
  name: string;
  slug: string;
  group: string;
}

interface RawMeta { name: string; slug: string; group: string }
const byEmoji = byEmojiRaw as Record<string, RawMeta>;
const ordered = orderedRaw as string[];

/** Все эмодзи в исходном (осмысленном, по группам) порядке датасета. */
export const EMOJI_CATALOG: EmojiEntry[] = ordered
  .filter((e) => byEmoji[e])
  .map((e) => ({ emoji: e, name: byEmoji[e].name, slug: byEmoji[e].slug, group: byEmoji[e].group }));

/** Поиск по названию (англ., подстрокой, все слова запроса должны совпасть). */
export function searchEmoji(query: string, limit = 300): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return EMOJI_CATALOG.slice(0, limit);
  const terms = q.split(/\s+/).filter(Boolean);
  const out: EmojiEntry[] = [];
  for (const e of EMOJI_CATALOG) {
    const hay = `${e.name} ${e.slug.replace(/_/g, ' ')}`;
    if (terms.every((t) => hay.includes(t))) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}
