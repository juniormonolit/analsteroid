// Стандартная палитра цвета — «как в Google Sheets» (пожелание Михаила, п.10
// спеки owners-inbox/analsteroid-edits-spec-agreed-20260708.md).
//
// Их color-picker собран из: строки градаций серого (10) + строки 10 насыщенных
// базовых цветов + нескольких строк оттенков (подмес к белому) для каждого
// базового цвета. Первые две строки — общеизвестные значения, воспроизводимые
// во множестве открытых клонов их пикера (Docs/Sheets/Slides используют одну и
// ту же палитру). Строки оттенков ниже — не проприетарная таблица Google (она
// нигде не публикуется как спецификация), а сгенерированные подмесом к белому
// той же ФОРМЫ: 10 базовых цветов × ступени, визуально совпадающая структура.

// Экспортирован — переиспользуется в ReportTable.tsx для градиентной интерполяции
// ручных порогов подсветки значений (п.9 спеки), не только для подмеса тонов палитры.
export function mixHex(hex: string, toHex: string, t: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(toHex.slice(1), 16);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return '#' + [r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('');
}

export const GS_GRAYSCALE_ROW: readonly string[] = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7',
  '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
];

export const GS_BASE_ROW: readonly string[] = [
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00',
  '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
];

// Доля подмеса к белому — чем больше, тем светлее (строки идут светлее книзу).
const TINT_STEPS: readonly number[] = [0.2, 0.35, 0.5, 0.65, 0.8, 0.92];

export const GS_TINT_ROWS: readonly string[][] = TINT_STEPS.map(t =>
  GS_BASE_ROW.map(c => mixHex(c, '#ffffff', t)),
);

/** Сетка палитры построчно: серый, базовые цвета, ступени тонов. 8×10 = 80 свотчей. */
export const GOOGLE_SHEETS_PALETTE_GRID: readonly (readonly string[])[] = [
  GS_GRAYSCALE_ROW,
  GS_BASE_ROW,
  ...GS_TINT_ROWS,
];

export const GOOGLE_SHEETS_PALETTE_FLAT: readonly string[] = GOOGLE_SHEETS_PALETTE_GRID.flat();
