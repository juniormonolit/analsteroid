// Текст шаблона рекомендаций: обычный текст + BB-коды Битрикса [URL=…]…[/URL], [URL]…[/URL], [IMG]…[/IMG]
// и голые ссылки. Просмотр в Монолитике — renderTemplateBody; в описание задачи Битрикса — templateToBitrix:
// [IMG] в DESCRIPTION задачи не проверен (память bitrix-bbcode-support: проверены только чат бота и чат
// задачи, [URL] там работает) — картинка уходит ссылкой «🖼 Картинка», это заведомо рисуется.
import type { ReactNode } from 'react';

const TOKEN = /\[IMG\]\s*(https?:\/\/[^\s[\]]+)\s*\[\/IMG\]|\[URL=(https?:\/\/[^\]\s]+)\]([\s\S]*?)\[\/URL\]|\[URL\](https?:\/\/[^\s[\]]+)\[\/URL\]|(https?:\/\/[^\s<>[\]]+)/gi;

const LINK = 'break-words text-[var(--color-accent)] underline underline-offset-2 hover:no-underline';

export function renderTemplateBody(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[1]) {
      out.push(
        <a key={k++} href={m[1]} target="_blank" rel="noreferrer" className="my-1 block w-fit max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={m[1]} alt="Картинка инструкции" loading="lazy"
            className="max-h-72 max-w-full rounded-lg border border-[var(--color-border)] object-contain" />
        </a>,
      );
    } else {
      const href = m[2] ?? m[4] ?? m[5];
      const label = m[2] ? (m[3] || m[2]) : href;
      out.push(<a key={k++} href={href} target="_blank" rel="noreferrer" className={LINK}>{label}</a>);
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** В описание задачи Битрикса: картинки — ссылкой (см. шапку файла), остальное как есть. */
export function templateToBitrix(text: string): string {
  return text.replace(/\[IMG\]\s*(https?:\/\/[^\s[\]]+)\s*\[\/IMG\]/gi, '[URL=$1]🖼 Картинка[/URL]');
}

/** Вставить фрагмент в textarea на место курсора (или заменить выделение); вернуть новый текст и позицию. */
export function insertAt(el: HTMLTextAreaElement | null, text: string, snippet: string): { next: string; caret: number } {
  const start = el?.selectionStart ?? text.length;
  const end = el?.selectionEnd ?? text.length;
  const before = text.slice(0, start);
  const pad = before && !before.endsWith('\n') && snippet.startsWith('[IMG]') ? '\n' : '';
  const next = `${before}${pad}${snippet}${text.slice(end)}`;
  return { next, caret: before.length + pad.length + snippet.length };
}
