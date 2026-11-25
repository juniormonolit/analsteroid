'use client';
// BB-разметка Битрикса → React без dangerouslySetInnerHTML (владелец 25.11: «информацию из задачи переносить целиком,
// чтобы не хотелось проваливаться в Битрикс»). Описания задач логистов/снабжения — с [TABLE] (товар, кол-во, наша цена,
// цена конкурента), [B]Поле:[/B], [URL], [USER]. Раньше теги просто вырезались и таблица слипалась в строку.
// Поддержано: B/I/U/S, URL (http/https), USER, TABLE/TR/TD/TH, переносы строк. Прочие теги — текст без тега.
import { Fragment, type ReactNode } from 'react';

import { parseBb, type Inline } from '../engine/bb';

const shortUrl = (h: string) => {
  try { const u = new URL(h); const p = u.pathname.length > 1 ? `${u.pathname.slice(0, 18)}${u.pathname.length > 18 ? '…' : ''}` : ''; return `${u.hostname.replace(/^www\./, '')}${p}`; } catch { return h; }
};

function renderInline(list: Inline[], portal: string | null): ReactNode {
  return list.map((n, i) => {
    switch (n.t) {
      case 'text': return <Fragment key={i}>{n.v}</Fragment>;
      case 'br': return <br key={i} />;
      case 'b': return <b key={i} className="font-semibold">{renderInline(n.c, portal)}</b>;
      case 'i': return <i key={i}>{renderInline(n.c, portal)}</i>;
      case 'u': return <u key={i}>{renderInline(n.c, portal)}</u>;
      case 's': return <s key={i}>{renderInline(n.c, portal)}</s>;
      case 'url': {
        // Голая длинная ссылка (Google-таблица на 150 символов, скрин 20) — коротко: «docs.google.com/…».
        const bare = n.c.length === 1 && n.c[0].t === 'text' && n.c[0].v.trim() === n.href;
        const label = bare ? shortUrl(n.href) : renderInline(n.c, portal);
        return <a key={i} href={n.href} target="_blank" rel="noreferrer" title={n.href} className="break-all text-[var(--color-accent)] underline">{label}</a>;
      }
      case 'user': return <span key={i} className="font-medium text-[var(--color-accent)]">{renderInline(n.c, portal)}</span>;
    }
  });
}

/** Отрисовка BB-текста. Таблицы — в .scroll-x (CLAUDE.md, правило 2). */
export function BbText({ text, className = '' }: { text: string; className?: string }) {
  const blocks = parseBb(text);
  return (
    <div className={`flex min-w-0 flex-col gap-2 break-words ${className}`}>
      {blocks.map((b, i) => b.t === 'inline' ? (
        <div key={i} className="min-w-0 whitespace-normal">{renderInline(b.c, null)}</div>
      ) : (
        <div key={i} className="scroll-x rounded-md border border-[var(--color-border)]">
          <table className="w-full min-w-max border-collapse text-[12.5px]">
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} className={ri === 0 ? 'bg-[var(--color-bg-hover)]' : 'border-t border-[var(--color-border)]'}>
                  {r.map((c, ci) => <td key={ci} className={`px-2 py-1 align-top ${ri === 0 ? 'font-semibold' : ''} ${ci > 0 ? 'whitespace-nowrap' : ''}`}>{renderInline(c, null)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
