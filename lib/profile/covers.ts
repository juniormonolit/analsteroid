// Каталог обложек профиля (ЛК-соцсетка, этап 2, задача владельца 05.08:
// «доступные для оформления шапки выдавать исходя из достижений: прокачал
// газобетон до 10 лвл — получил шапку в виде газобетонной кладки»).
//
// Обложки ГЕНЕРАТИВНЫЕ — чистый CSS-background (градиенты/паттерны), никаких
// картинок и внешних ассетов: нечего хранить, нечего модерировать, ноль веса.
// Файл импортируется и сервером (валидация разблокировки в POST /api/profile/cover),
// и клиентом (рендер шапки и пикер) — держать без server-only зависимостей.
//
// requiresClass — имя класса XP ДОСЛОВНО как в xp_class_map.class_name
// (проверено по живой БД 05.08: ЖБИ, Кровля, Металл, Нерудка, Стеновые,
// Утепление). «Газобетон» из примера владельца — это класс «Стеновые».

import type { CSSProperties } from 'react';

export interface CoverDef {
  id: string;
  name: string;
  /** CSS-значение для style.background (можно многослойное). */
  css: string;
  /** background-size, если паттерну нужен явный тайлинг. */
  size?: string;
  /** Класс XP, которым обложка разблокируется; отсутствие = доступна всем. */
  requiresClass?: string;
  /** Минимальный уровень класса (по владельцу — 10). */
  minClassLevel?: number;
}

export const DEFAULT_COVER_ID = 'base-sky';

/**
 * Обложка-замощение из эмодзи. Тёмная подложка + полупрозрачные глифы: на светлой
 * подложке эмодзи спорят с белым текстом шапки, который лежит поверх.
 */
function emojiCover(id: string, name: string, emoji: string[], backdrop: string): CoverDef {
  const cell = 96;
  const w = cell * emoji.length;
  const h = Math.round(cell * 0.8);
  const glyphs = emoji
    .map((e, i) => `<text x="${cell * i + cell / 2}" y="${i % 2 === 0 ? h * 0.45 : h * 0.85}" font-size="30" text-anchor="middle" opacity="0.30">${e}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${glyphs}</svg>`;
  return {
    id, name,
    css: `${backdrop} url("data:image/svg+xml,${encodeURIComponent(svg)}") repeat`,
    size: `${w}px ${h}px`,
  };
}

export const COVERS: CoverDef[] = [
  // ── Базовые: доступны всем ─────────────────────────────────────────────────
  { id: 'base-sky', name: 'Небо', css: 'linear-gradient(135deg,#4a90d9 0%,#1b4f8a 100%)' },
  { id: 'base-sunset', name: 'Закат', css: 'linear-gradient(135deg,#f6a14d 0%,#d4517a 55%,#5b3fa8 100%)' },
  { id: 'base-emerald', name: 'Изумруд', css: 'linear-gradient(135deg,#2f9e44 0%,#0b7285 100%)' },
  { id: 'base-graphite', name: 'Графит', css: 'linear-gradient(135deg,#343a40 0%,#212529 60%,#1b2735 100%)' },
  // ── За достижения: уровень класса ≥ 10 ────────────────────────────────────
  {
    id: 'class-stenovye', name: 'Кладка', requiresClass: 'Стеновые', minClassLevel: 10,
    // Газобетонная кладка: светлые блоки, шахматный шов через два слоя сетки.
    css: '#c9cfd6 repeating-linear-gradient(0deg, transparent 0 26px, #9aa3ad 26px 29px), repeating-linear-gradient(90deg, transparent 0 78px, #9aa3ad 78px 81px), repeating-linear-gradient(90deg, transparent 0 39px, rgba(154,163,173,.55) 39px 40.5px)',
  },
  {
    id: 'class-krovlya', name: 'Черепица', requiresClass: 'Кровля', minClassLevel: 10,
    // «Рыбья чешуя» — классический CSS-паттерн двумя радиальными градиентами.
    css: '#7e352a radial-gradient(circle at 100% 150%, #7e352a 24%, #a3462f 25%, #a3462f 28%, #7e352a 29%, #7e352a 36%, #a3462f 36%, #a3462f 40%, transparent 40%, transparent) 0 0 / 48px 24px, radial-gradient(circle at 0 150%, #7e352a 24%, #a3462f 25%, #a3462f 28%, #7e352a 29%, #7e352a 36%, #a3462f 36%, #a3462f 40%, transparent 40%, transparent) 24px 0 / 48px 24px',
  },
  {
    id: 'class-metall', name: 'Прокат', requiresClass: 'Металл', minClassLevel: 10,
    css: 'repeating-linear-gradient(115deg, #8d99a6 0 14px, #b7c1cc 14px 20px, #9aa5b1 20px 34px), linear-gradient(180deg, rgba(255,255,255,.18), rgba(0,0,0,.15))',
  },
  {
    id: 'class-zhbi', name: 'Арматурная сетка', requiresClass: 'ЖБИ', minClassLevel: 10,
    css: '#868e96 linear-gradient(#5f676f 2px, transparent 2px) 0 0 / 26px 26px, linear-gradient(90deg, #5f676f 2px, transparent 2px) 0 0 / 26px 26px',
  },
  {
    id: 'class-nerudka', name: 'Щебень', requiresClass: 'Нерудка', minClassLevel: 10,
    css: '#7d8288 radial-gradient(circle 7px at 12px 14px, #9aa0a6 96%, transparent), radial-gradient(circle 9px at 40px 34px, #6b7076 96%, transparent), radial-gradient(circle 6px at 66px 10px, #8d939a 96%, transparent), radial-gradient(circle 8px at 86px 42px, #a5abb2 96%, transparent), radial-gradient(circle 5px at 30px 52px, #656a70 96%, transparent), radial-gradient(circle 7px at 74px 62px, #90969d 96%, transparent)',
    size: '96px 72px',
  },
  {
    id: 'class-uteplenie', name: 'Утеплитель', requiresClass: 'Утепление', minClassLevel: 10,
    css: '#d9b45e repeating-linear-gradient(180deg, rgba(255,255,255,.28) 0 6px, transparent 6px 22px), repeating-linear-gradient(90deg, rgba(140,105,35,.25) 0 3px, transparent 3px 30px)',
  },
  // ── Эмодзи-обложки: доступны всем (правка владельца 06.08 «накинь обложки из
  // эмодзи»). Замощение — SVG в data-URI, как у фонов профиля: ни картинок, ни
  // внешних запросов. Плотность ниже, чем у фонов: обложка — крупное полотно,
  // на нём частая сетка выглядит рябью.
  emojiCover('emoji-skulls', 'Черепа', ['💀', '☠️'], '#26262b'),
  emojiCover('emoji-fire', 'Пламя', ['🔥', '⚡'], '#2a1206'),
  emojiCover('emoji-money', 'Богатство', ['💰', '💎', '🪙'], '#0f3d2e'),
  emojiCover('emoji-build', 'Стройка', ['🧱', '🏗️', '🔨'], '#3a332a'),
  emojiCover('emoji-champion', 'Чемпион', ['🏆', '👑', '🥇'], '#3d3410'),
  emojiCover('emoji-space', 'Космос', ['🚀', '🛸', '⭐'], '#141833'),
];

export function coverById(id: string | null | undefined): CoverDef {
  return COVERS.find(c => c.id === id) ?? COVERS.find(c => c.id === DEFAULT_COVER_ID)!;
}

/** Готовый style для React: background + при необходимости background-size. */
export function coverStyle(id: string | null | undefined): CSSProperties {
  const def = coverById(id);
  const style: CSSProperties = { background: def.css };
  if (def.size) style.backgroundSize = def.size;
  return style;
}

/** Разблокирована ли обложка при данных уровнях классов ({имя → уровень}). */
export function isCoverUnlocked(def: CoverDef, classLevels: Record<string, number>): boolean {
  if (!def.requiresClass || !def.minClassLevel) return true;
  return (classLevels[def.requiresClass] ?? 0) >= def.minClassLevel;
}

/** Человекочитаемое условие разблокировки (для пикера). */
export function coverRequirementLabel(def: CoverDef): string | null {
  if (!def.requiresClass || !def.minClassLevel) return null;
  return `«${def.requiresClass}» ${def.minClassLevel} ур.`;
}
