// Каталог косметики профиля: рамки аватара и эмодзи-фоны (задача #34).
//
// Тот же принцип, что у обложек (lib/profile/covers.ts): всё ГЕНЕРАТИВНОЕ —
// CSS-градиенты и эмодзи из шрифта. Ни картинок, ни ассетов, ни модерации:
// новая рамка = строка в этом файле, а не загрузка файла и не запись в БД.
//
// Файл импортируют и сервер (валидация покупки и надевания), и клиент (пикер,
// рендер аватара) — держать без server-only зависимостей.
//
// Цены — в MLT (валюта EBALL в леджере). Ориентир владельца по экономике:
// курс 7,5 ₽ за MLT, медианный менеджер получает ништяк раз в несколько дней.
// Поэтому косметика намеренно дешёвая: это не конкурент отгулу за 3000, а то,
// на что не жалко спустить сдачу. Дорогие позиции — только «понтовые».

export type CosmeticKind = 'frame' | 'background';

export interface CosmeticDef {
  id: string;
  kind: CosmeticKind;
  name: string;
  /** Цена в MLT. 0 — доступна всем сразу, покупать не нужно. */
  price: number;
  /** Рамка: CSS-значение для background рамочного слоя (кольцо вокруг аватара). */
  ring?: string;
  /** Фон: эмодзи, которыми замощается подложка. */
  emoji?: string[];
  /** Фон: цвет подложки под эмодзи. */
  backdrop?: string;
}

export const COSMETICS: CosmeticDef[] = [
  // ── Рамки ──────────────────────────────────────────────────────────────────
  { id: 'frame-none', kind: 'frame', name: 'Без рамки', price: 0, ring: 'transparent' },
  { id: 'frame-steel', kind: 'frame', name: 'Сталь', price: 150,
    ring: 'linear-gradient(135deg,#c7ced6 0%,#8d99a6 45%,#eef2f6 55%,#8d99a6 100%)' },
  { id: 'frame-copper', kind: 'frame', name: 'Медь', price: 250,
    ring: 'linear-gradient(135deg,#e0a06a 0%,#a35d2c 45%,#f4cba4 55%,#a35d2c 100%)' },
  { id: 'frame-emerald', kind: 'frame', name: 'Изумруд', price: 400,
    ring: 'linear-gradient(135deg,#3ddc84 0%,#0b7285 50%,#3ddc84 100%)' },
  { id: 'frame-gold', kind: 'frame', name: 'Золото', price: 800,
    ring: 'linear-gradient(135deg,#ffe07a 0%,#c9922b 40%,#fff4c2 52%,#c9922b 65%,#ffe07a 100%)' },
  { id: 'frame-rainbow', kind: 'frame', name: 'Радуга', price: 1200,
    ring: 'conic-gradient(#ff5c5c,#ffb347,#ffe66d,#5cd68a,#4aa3e0,#8f7ae5,#ff5c5c)' },

  // ── Эмодзи-фоны ────────────────────────────────────────────────────────────
  { id: 'bg-none', kind: 'background', name: 'Без фона', price: 0 },
  { id: 'bg-build', kind: 'background', name: 'Стройка', price: 200,
    emoji: ['🧱', '🏗️', '🔨'], backdrop: '#f2ede4' },
  { id: 'bg-money', kind: 'background', name: 'Деньги', price: 350,
    emoji: ['💰', '💸', '🪙'], backdrop: '#eef7ee' },
  { id: 'bg-fire', kind: 'background', name: 'Огонь', price: 350,
    emoji: ['🔥', '⚡'], backdrop: '#fdeee6' },
  { id: 'bg-space', kind: 'background', name: 'Космос', price: 500,
    emoji: ['🚀', '⭐', '🛸'], backdrop: '#e9ecf7' },
  { id: 'bg-champion', kind: 'background', name: 'Чемпион', price: 900,
    emoji: ['🏆', '🥇', '👑'], backdrop: '#fdf6e3' },
];

export const DEFAULT_FRAME_ID = 'frame-none';
export const DEFAULT_BACKGROUND_ID = 'bg-none';

const BY_ID = new Map(COSMETICS.map(c => [c.id, c]));

export function cosmeticById(id: string | null | undefined): CosmeticDef | null {
  return id ? BY_ID.get(id) ?? null : null;
}

export function cosmeticsOfKind(kind: CosmeticKind): CosmeticDef[] {
  return COSMETICS.filter(c => c.kind === kind);
}

/** Бесплатное владеть не нужно — «Без рамки» доступна всем всегда. */
export function isFree(c: CosmeticDef): boolean {
  return c.price === 0;
}

/**
 * CSS-фон эмодзи-подложки. Эмодзи раскладываются по диагональной сетке
 * средствами SVG в data-URI: так это одна строка стиля без DOM-элементов и
 * без внешних запросов (CSP артефактов и превью тоже не мешает).
 */
export function backgroundCss(c: CosmeticDef | null): { background: string; backgroundSize?: string } | null {
  if (!c || c.kind !== 'background' || !c.emoji || c.emoji.length === 0) return null;
  // Шаг сетки и прозрачность подобраны на живом превью: при 44px/0.5 фон
  // «съедал» имя и цифры поверх него — на скрине читалось хуже, чем без фона.
  // Это украшение, оно не должно мешать читать профиль.
  const cell = 58;
  const size = cell * c.emoji.length;
  const glyphs = c.emoji
    .map((e, i) => {
      const x = cell * i + cell / 2;
      const y = i % 2 === 0 ? cell * 0.55 : cell * 0.95;
      return `<text x="${x}" y="${y}" font-size="19" text-anchor="middle" opacity="0.22">${e}</text>`;
    })
    .join('');
  // Высота плитки и backgroundSize обязаны совпадать: разойдутся — браузер
  // масштабирует картинку, и эмодзи поедут по вертикали при повторе.
  const tileH = Math.round(cell * 1.3);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${tileH}">${glyphs}</svg>`;
  const uri = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return { background: `${c.backdrop ?? 'transparent'} ${uri} repeat`, backgroundSize: `${size}px ${tileH}px` };
}
