// Теги заказчиков (миграция 245): цвета — колонки «Основной палитры» (Google Sheets 10×8):
// фон — ряд light3, текст — dark2, точка — dark1. Общий для сервера и клиента.

export interface TagDef {
  id: number;
  name: string;
  color: TagColor;
  /** Базовый тег (для всех, удалить нельзя); иначе — личный тег смотрящего. */
  system: boolean;
}

export const TAG_COLORS = {
  red:        { label: 'Красный',    bg: '#f4cccc', fg: '#990000', dot: '#cc0000' },
  orange:     { label: 'Оранжевый',  bg: '#fce5cd', fg: '#b45f06', dot: '#e69138' },
  yellow:     { label: 'Жёлтый',     bg: '#fff2cc', fg: '#7f6000', dot: '#f1c232' },
  green:      { label: 'Зелёный',    bg: '#d9ead3', fg: '#38761d', dot: '#6aa84f' },
  cyan:       { label: 'Бирюзовый',  bg: '#d0e0e3', fg: '#134f5c', dot: '#45818e' },
  cornflower: { label: 'Голубой',    bg: '#c9daf8', fg: '#1155cc', dot: '#3c78d8' },
  blue:       { label: 'Синий',      bg: '#cfe2f3', fg: '#0b5394', dot: '#3d85c6' },
  purple:     { label: 'Фиолетовый', bg: '#d9d2e9', fg: '#351c75', dot: '#674ea7' },
  magenta:    { label: 'Малиновый',  bg: '#ead1dc', fg: '#741b47', dot: '#a64d79' },
  gray:       { label: 'Серый',      bg: '#efefef', fg: '#434343', dot: '#999999' },
} as const;
export type TagColor = keyof typeof TAG_COLORS;
export const isTagColor = (x: unknown): x is TagColor => typeof x === 'string' && x in TAG_COLORS;
/** Значение фильтра «без тегов». */
export const NO_TAG = 'none';
