// Русское склонение числительных (п.7 правок 09.07/2 — «Итого: N <измерение>»).
// Стандартное правило: 1 → форма[0], 2-4 → форма[1], 5-20 и 0/5-9 → форма[2].
export function pluralizeRu(n: number, forms: readonly [string, string, string]): string {
  const n100 = Math.abs(n) % 100;
  const n10 = n100 % 10;
  if (n100 > 10 && n100 < 20) return forms[2];
  if (n10 === 1) return forms[0];
  if (n10 >= 2 && n10 <= 4) return forms[1];
  return forms[2];
}

// Склонение измерения строки отчёта для строки «Итого: N ...» — только основные
// измерения (менеджеры/товарные группы/источники), для прочих — «строк» (по спеке).
const DIMENSION_NOUN_FORMS: [RegExp, readonly [string, string, string]][] = [
  [/менеджер/i, ['менеджер', 'менеджера', 'менеджеров']],
  [/товарн/i, ['товарная группа', 'товарные группы', 'товарных групп']],
  [/^источник/i, ['источник', 'источника', 'источников']],
];
const FALLBACK_FORMS = ['строка', 'строки', 'строк'] as const;

export function dimensionCountLabel(dimensionLabel: string, n: number): string {
  const forms = DIMENSION_NOUN_FORMS.find(([re]) => re.test(dimensionLabel))?.[1] ?? FALLBACK_FORMS;
  return `${n} ${pluralizeRu(n, forms)}`;
}

const DEAL_FORMS = ['сделка', 'сделки', 'сделок'] as const;
export function dealsCountLabel(n: number): string {
  return `${n} ${pluralizeRu(n, DEAL_FORMS)}`;
}
