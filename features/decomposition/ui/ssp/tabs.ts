// Вкладки «ССП тест»: верхний уровень — «Общая», филиалы, «Менеджеры»; внутри филиала —
// листы его отделов. Имена листов совпадают с именами листов xlsx
// (features/decomposition/data/decomposition-2026.json → sheets[].name); список продублирован
// здесь, чтобы клиент не тянул сам JSON (~800 КБ).
export const TOP_TABS = ['overview', 'spb', 'msk', 'krd', 'managers'] as const;
export type TopTab = (typeof TOP_TABS)[number];

export const TOP_TAB_LABELS: Record<TopTab, string> = {
  overview: 'Общая', spb: 'Санкт-Петербург', msk: 'Москва', krd: 'Краснодар', managers: 'Менеджеры',
};

export interface SheetTab { sheet: string; label: string }

export const CITY_SHEETS: Record<'spb' | 'msk' | 'krd', SheetTab[]> = {
  spb: [
    { sheet: 'СПБ (ОС)', label: 'ОС' }, { sheet: 'СПБ (НЦ)', label: 'НЦ' }, { sheet: 'СПБ (НЦ ЖБИ)', label: 'НЦ ЖБИ' },
    { sheet: 'СПБ (НЦ Металл)', label: 'НЦ Металл' }, { sheet: 'СПБ (ЖБИ-рег)', label: 'ЖБИ-рег' }, { sheet: 'СПБ (ЮЛ)', label: 'ЮЛ' },
  ],
  msk: [
    { sheet: 'МСК (ОС)', label: 'ОС' }, { sheet: 'МСК (НЦ)', label: 'НЦ' }, { sheet: 'МСК (НЦ ЖБИ)', label: 'НЦ ЖБИ' }, { sheet: 'МСК (НЦ Металл)', label: 'НЦ Металл' },
  ],
  krd: [
    { sheet: 'КРД (ОС)', label: 'ОС' }, { sheet: 'КРД (НЦ)', label: 'НЦ' }, { sheet: 'КРД (НЦ ЖБИ)', label: 'НЦ ЖБИ' },
  ],
};

export const ALL_SHEETS: string[] = Object.values(CITY_SHEETS).flat().map(t => t.sheet);
