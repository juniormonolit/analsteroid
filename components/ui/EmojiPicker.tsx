'use client';
// Полный эмодзи-пикер с поиском (задача 2994, правка владельца: «так мало
// эмодзи в конструкторе товаров, добавь полный список с поиском»). Данные —
// unicode-emoji-json (lib/emoji/catalog.ts), рендерятся системным эмодзи-
// шрифтом браузера — картинок не грузим (тот же принцип, что и раньше:
// «эмодзи вместо фото — картинок не храним»).

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { searchEmoji } from '@/lib/emoji/catalog';
import { firstGraphemes } from '@/lib/text/graphemes';

export function EmojiPicker({ onPick, trigger }: {
  onPick: (emoji: string) => void;
  /** Кастомный триггер — если не передан, обычная кнопка «Ещё эмодзи…». */
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchEmoji(query, 240), [query]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}
      className="w-[320px] max-w-[calc(100vw-16px)] p-0"
      trigger={
        trigger ?? (
          <button type="button"
            className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs hover:bg-[var(--color-bg-hover)]">
            🔍 Ещё эмодзи…
          </button>
        )
      }
    >
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] p-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
          <Search size={13} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию (англ.) — cake, fire, rocket…"
            className="w-full bg-transparent text-[16px] sm:text-sm outline-none text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
          />
        </div>
      </div>
      <div className="grid grid-cols-8 gap-0.5 p-2 max-h-[280px] overflow-y-auto">
        {results.length === 0 && (
          <div className="col-span-8 py-6 text-center text-xs text-[var(--color-text-muted)]">Ничего не найдено</div>
        )}
        {results.map((e) => (
          <button
            key={e.emoji}
            type="button"
            title={e.name}
            onClick={() => {
              // firstGraphemes — на всякий случай, если в датасете вдруг
              // окажется составная последовательность длиннее одной графемы;
              // одна и та же функция, что режет paste в самом поле (2994).
              onPick(firstGraphemes(e.emoji, 8));
              setOpen(false);
              setQuery('');
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-xl hover:bg-[var(--color-bg-hover)]"
          >
            {e.emoji}
          </button>
        ))}
      </div>
    </Popover>
  );
}
