// BB-разметка Битрикса → дерево (без HTML). Общая для сервера (разбор описаний задач логистов: поля, таблицы товаров с
// ценой конкурента) и клиента (ui/BbText.tsx). Поддержано: B/I/U/S, URL (http/https), USER, TABLE/TR/TD/TH, переносы.
// Прочие теги выбрасываются, текст остаётся.
export type Inline = { t: 'text'; v: string } | { t: 'b' | 'i' | 'u' | 's'; c: Inline[] } | { t: 'url'; href: string; c: Inline[] } | { t: 'user'; id: string; c: Inline[] } | { t: 'br' };
export type Block = { t: 'inline'; c: Inline[] } | { t: 'table'; rows: Inline[][][] };

const TAG = /\[(\/?)([a-z]+)(?:=([^\]]*))?\]/gi;
const safeHref = (h: string) => (/^https?:\/\//i.test(h.trim()) ? h.trim() : null);

/** Строка без таблиц → инлайн-дерево. Незакрытые теги закрываются в конце. */
function parseInline(src: string): Inline[] {
  const root: Inline[] = [];
  const stack: { tag: string; node: Inline & { c: Inline[] } }[] = [];
  const cur = () => (stack.length ? stack[stack.length - 1].node.c : root);
  // Голые ссылки в тексте (логист вставляет Google-таблицы без [URL]) — тоже ссылки; внутри [URL] не трогаем.
  const pushText = (s: string) => {
    const inUrl = stack.some(x => x.node.t === 'url');
    const parts = s.split('\n');
    parts.forEach((p, i) => {
      if (p) {
        if (inUrl) cur().push({ t: 'text', v: p });
        else {
          let last = 0;
          for (const m of p.matchAll(/https?:\/\/[^\s<>"\]\[]+[^\s<>"\]\[.,;:!?)]/g)) {
            if (m.index! > last) cur().push({ t: 'text', v: p.slice(last, m.index) });
            cur().push({ t: 'url', href: m[0], c: [{ t: 'text', v: m[0] }] });
            last = m.index! + m[0].length;
          }
          if (last < p.length) cur().push({ t: 'text', v: p.slice(last) });
        }
      }
      if (i < parts.length - 1) cur().push({ t: 'br' });
    });
  };
  let last = 0;
  for (const m of src.matchAll(TAG)) {
    pushText(src.slice(last, m.index));
    last = m.index! + m[0].length;
    const close = m[1] === '/', tag = m[2].toLowerCase(), arg = m[3] ?? '';
    if (close) {
      const i = stack.map(s => s.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    let node: (Inline & { c: Inline[] }) | null = null;
    if (tag === 'b' || tag === 'i' || tag === 'u' || tag === 's') node = { t: tag, c: [] };
    else if (tag === 'url') { const href = safeHref(arg); node = href ? { t: 'url', href, c: [] } : { t: 'u', c: [] }; }
    else if (tag === 'user' && /^\d+$/.test(arg)) node = { t: 'user', id: arg, c: [] };
    if (!node) continue; // неизвестный тег — выбрасываем сам тег, текст остаётся
    cur().push(node);
    stack.push({ tag, node });
  }
  pushText(src.slice(last));
  // [URL]https://…[/URL] без аргумента — ссылка на сам текст
  const fix = (list: Inline[]) => list.forEach((n, i) => {
    if ('c' in n) fix(n.c);
    if (n.t === 'u' && n.c.length === 1 && n.c[0].t === 'text' && safeHref(n.c[0].v)) list[i] = { t: 'url', href: n.c[0].v.trim(), c: n.c };
  });
  fix(root);
  return root;
}

export function parseBb(raw: string): Block[] {
  const src = raw.replace(/\r/g, '');
  const blocks: Block[] = [];
  const re = /\[table\]([\s\S]*?)\[\/table\]/gi;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const before = src.slice(last, m.index).replace(/^\n+|\n+$/g, '');
    if (before) blocks.push({ t: 'inline', c: parseInline(before) });
    const rows = [...m[1].matchAll(/\[tr\]([\s\S]*?)\[\/tr\]/gi)].map(r => [...r[1].matchAll(/\[t[dh]\]([\s\S]*?)\[\/t[dh]\]/gi)].map(c => parseInline(c[1].trim())));
    if (rows.length) blocks.push({ t: 'table', rows });
    last = m.index! + m[0].length;
  }
  const tail = src.slice(last).replace(/^\n+|\n+$/g, '');
  if (tail) blocks.push({ t: 'inline', c: parseInline(tail) });
  return blocks;
}

/** Плоский текст ячейки — для заголовков/сравнения. */
export const inlineText = (c: Inline[]): string => c.map(n => (n.t === 'text' ? n.v : n.t === 'br' ? ' ' : 'c' in n ? inlineText(n.c) : '')).join('');

