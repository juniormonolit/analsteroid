// Генеративная косметика профиля — рандомайзер за MLT (задача 63, п.1).
//
// Владелец 06.08.2026: «Фоны, шапки и рамки предлагаю сделать там рандомайзер,
// генерирующий за MLT».
//
// КЛЮЧЕВОЕ РЕШЕНИЕ: вариант целиком выводится ИЗ СВОЕГО ID. Идентификатор
// выглядит как `gen-frame-7f3a91`, где хвост — сид, и весь внешний вид
// считается из него функцией без обращения к БД. Поэтому:
//   * чужой профиль рисуется по одному тексту в `profile_cosmetics.frame_id`,
//     без второго запроса «а что это за вариант»;
//   * БД хранит только факт «этот сид прокручен и закреплён», а не CSS;
//   * ничего не надо мигрировать, если завтра поменяется палитра — старые
//     сиды просто станут выглядеть иначе, и это осознанная плата за отсутствие
//     хранилища (альтернатива — держать CSS-строки в БД и чинить их руками).
//
// Картинок здесь нет и не будет: владелец 07.08.2026 на предложение «своя
// картинка в шапку» ответил «нахуй». Это снимает и хранилище, и модерацию.

import type { CosmeticDef } from './cosmetics';
import type { CoverDef } from './covers';

export type GenKind = 'frame' | 'background' | 'cover';

const PREFIX: Record<GenKind, string> = {
  frame: 'gen-frame-', background: 'gen-bg-', cover: 'gen-cover-',
};

export function isGeneratedId(id: string | null | undefined): boolean {
  return !!id && Object.values(PREFIX).some(p => id.startsWith(p));
}
export function generatedKind(id: string): GenKind | null {
  for (const [k, p] of Object.entries(PREFIX)) if (id.startsWith(p)) return k as GenKind;
  return null;
}
export function makeGeneratedId(kind: GenKind, seed: string): string {
  return PREFIX[kind] + seed;
}
function seedOf(id: string): string {
  const k = generatedKind(id);
  return k ? id.slice(PREFIX[k].length) : id;
}

/** Свежий сид. Шесть символов hex — 16 млн вариантов, повтор человек не заметит. */
export function newSeed(): string {
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

// ── детерминированный генератор из сида ──────────────────────────────────────
// Простейший xorshift: нужна воспроизводимость, а не криптостойкость. Важно,
// что он одинаково работает на сервере и в браузере — иначе превью в пикере и
// реальная рамка разошлись бы.
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}
const pick = <T,>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length) % arr.length];
const hsl = (r: () => number, s: [number, number], l: [number, number], hue?: number) => {
  const h = hue ?? Math.floor(r() * 360);
  return `hsl(${h} ${Math.round(s[0] + r() * (s[1] - s[0]))}% ${Math.round(l[0] + r() * (l[1] - l[0]))}%)`;
};

const GEN_EMOJI = ['🔩', '🧱', '🪵', '🚧', '⚒️', '🏗️', '📦', '🧰', '⚙️', '🔨', '🪜', '🧲',
  '⭐', '⚡', '🔥', '💎', '🌊', '🍀', '🎯', '🚀'];

/** Рамка аватара по сиду. */
export function generatedFrame(id: string): CosmeticDef {
  const r = rng(seedOf(id));
  const base = Math.floor(r() * 360);
  const shift = 40 + Math.floor(r() * 200);
  const style = pick(r, ['linear', 'conic', 'triple']);
  const c1 = hsl(r, [55, 90], [45, 65], base);
  const c2 = hsl(r, [55, 90], [40, 60], (base + shift) % 360);
  const c3 = hsl(r, [50, 85], [55, 75], (base + shift * 2) % 360);
  const ring = style === 'conic'
    ? `conic-gradient(from ${Math.floor(r() * 360)}deg,${c1},${c2},${c3},${c1})`
    : style === 'triple'
      ? `linear-gradient(${Math.floor(r() * 360)}deg,${c1} 0%,${c2} 45%,${c3} 55%,${c2} 100%)`
      : `linear-gradient(${Math.floor(r() * 360)}deg,${c1},${c2})`;
  return { id, kind: 'frame', name: `Своя рамка ${seedOf(id)}`, price: 0, ring };
}

/** Эмодзи-фон по сиду. */
export function generatedBackground(id: string): CosmeticDef {
  const r = rng(seedOf(id));
  const n = 2 + Math.floor(r() * 3);
  const emoji: string[] = [];
  while (emoji.length < n) {
    const e = pick(r, GEN_EMOJI);
    if (!emoji.includes(e)) emoji.push(e);
  }
  return {
    id, kind: 'background', name: `Свой фон ${seedOf(id)}`, price: 0,
    emoji, backdrop: hsl(r, [25, 60], [88, 96]),
  };
}

/** Обложка профиля по сиду. */
export function generatedCover(id: string): CoverDef {
  const r = rng(seedOf(id));
  const base = Math.floor(r() * 360);
  const c1 = hsl(r, [45, 80], [30, 50], base);
  const c2 = hsl(r, [45, 80], [22, 42], (base + 30 + Math.floor(r() * 120)) % 360);
  const kind = pick(r, ['linear', 'radial', 'stripes']);
  const css = kind === 'radial'
    ? `radial-gradient(circle at ${20 + Math.floor(r() * 60)}% ${20 + Math.floor(r() * 60)}%, ${c1}, ${c2})`
    : kind === 'stripes'
      ? `repeating-linear-gradient(${Math.floor(r() * 180)}deg, ${c1} 0 18px, ${c2} 18px 36px)`
      : `linear-gradient(${Math.floor(r() * 360)}deg, ${c1}, ${c2})`;
  return { id, name: `Своя обложка ${seedOf(id)}`, css };
}

/** Разрешить сгенерированный id в определение нужного вида. */
export function resolveGenerated(id: string): CosmeticDef | CoverDef | null {
  switch (generatedKind(id)) {
    case 'frame': return generatedFrame(id);
    case 'background': return generatedBackground(id);
    case 'cover': return generatedCover(id);
    default: return null;
  }
}
