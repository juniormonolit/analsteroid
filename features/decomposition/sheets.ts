// Данные листов «2026 Декомпозиция (Основная).xlsx» (импорт — scripts/import-decomposition-xlsx.mjs)
// и справочники для сопоставления строк листов с фактом из sa.deals.
// Только сервер: JSON ~800 КБ, в клиентский бандл не тянуть.
import dataset from './data/decomposition-2026.json' with { type: 'json' };

export type BlockKind = 'sum' | 'ratio';
export type BlockUnit = 'money' | 'count' | 'count1' | 'pct';
export type FunnelSplit = 'all' | 'primary' | 'repeat';

export interface BlockDef { key: string; label: string; kind: BlockKind; unit: BlockUnit }
export interface SheetRow { label: string; year: number | null; months: number[]; primary?: number[]; repeat?: number[] }
export interface SheetBlock extends BlockDef { hasSplit: boolean; total: SheetRow; rows: SheetRow[] }
export interface DeptSheet { name: string; workingDays: number[] | null; blocks: SheetBlock[] }
export interface ManagerPlanRow { key: string; bitrixId: string | null; scope: string | null; name: string | null; year: number | null; months: number[]; primary: number[]; repeat: number[] }
export interface ManagersBlock { key: 'ship_sum' | 'sales_sum'; label: string; total: { months: number[]; primary: number[]; repeat: number[] }; managers: ManagerPlanRow[] }
export interface Dataset { year: number; sourceFile: string; importedAt: string; blocks: BlockDef[]; sheets: DeptSheet[]; managers: { blocks: ManagersBlock[] } }

export const DATASET = dataset as unknown as Dataset;

export function getSheet(name: string): DeptSheet | undefined {
  return DATASET.sheets.find(s => s.name === name);
}

export const SHEET_NAMES: string[] = DATASET.sheets.map(s => s.name);

// ── Какие сотрудники дают факт листу ──────────────────────────────────────────
// Категории факта — те же, что в Сводной (lib/org/deptCategories: branch:category).
// У части листов своего отдела нет — факт делится по СЕМЕЙСТВУ товарных групп
// (МСК «НЦ Металл» = металл у менеджеров МСК НЦ; КРД «НЦ ЖБИ» = ЖБИ у КРД НЦ),
// либо факта нет вовсе (СПб «ЖБИ-рег» — региональный ярлык, не отдел).
export type ProductFamily = 'os' | 'nc' | 'zhbi' | 'metal' | 'other';

export interface SheetScope {
  /** branch:category из deptCategories; «<филиал>:*» — все менеджеры филиала. */
  category: string | null;
  /** Только B2B-воронки (юрлица, funnel_id 1/3) — лист «СПБ (ЮЛ)». */
  b2bOnly?: boolean;
  /** Ограничить факт семейством товаров (null — все). */
  family?: ProductFamily | null;
  /** Исключить семейства (например, у МСК (НЦ) убрать металл, который ушёл в лист «НЦ Металл»). */
  excludeFamilies?: ProductFamily[];
  note?: string;
}

export const SHEET_SCOPES: Record<string, SheetScope> = {
  'СПБ (ОС)':        { category: 'СПБ:ОС', note: 'Факт — Департамент ОС вместе с ЮЛ и «Отделом продаж» без подотдела (как в Сводной).' },
  // Отдел «Департамент ЮЛ» — 2 человека без отгрузок в 2026 (проверено 10.10), а план
  // листа 242 млн: ЮЛ здесь — юрлица, то есть B2B-воронки у всех менеджеров СПб.
  'СПБ (ЮЛ)':        { category: 'СПБ:*', b2bOnly: true, note: 'ЮЛ = юрлица: факт — сделки B2B-воронок у всех менеджеров СПб (во всех отделах); эти же сделки входят в листы своих отделов.' },
  'СПБ (НЦ)':        { category: 'СПБ:НЦ' },
  'СПБ (НЦ ЖБИ)':    { category: 'СПБ:НЦ ЖБИ', note: 'Факт — «Отдел ЖБИ» целиком; план регионального ЖБИ лежит отдельным листом «СПБ (ЖБИ-рег)» без своего факта.' },
  'СПБ (НЦ Металл)': { category: 'СПБ:НЦ Металл' },
  'СПБ (ЖБИ-рег)':   { category: null, note: 'Региональный ЖБИ — ярлык без своего отдела: факта нет, показан только план.' },
  'МСК (ОС)':        { category: 'МСК:ОС' },
  'МСК (НЦ)':        { category: 'МСК:НЦ', excludeFamilies: ['metal'], note: 'Факт — «МСК НЦ» без металлопроката (металл — в листе «МСК (НЦ Металл)»).' },
  'МСК (НЦ ЖБИ)':    { category: 'МСК:ЖБИ' },
  'МСК (НЦ Металл)': { category: 'МСК:НЦ', family: 'metal', note: 'Отдельного отдела нет: факт — металлопрокат у менеджеров «МСК НЦ».' },
  'КРД (ОС)':        { category: 'КРД:ОС' },
  'КРД (НЦ)':        { category: 'КРД:НЦ', excludeFamilies: ['zhbi'], note: 'Факт — «КРД НЦ» без ЖБИ (ЖБИ — в листе «КРД (НЦ ЖБИ)»).' },
  'КРД (НЦ ЖБИ)':    { category: 'КРД:НЦ', family: 'zhbi', note: 'Отдельного отдела нет: факт — ЖБИ у менеджеров «КРД НЦ».' },
};

// ── Товарные группы: head_group_name сделки → строка листа ────────────────────
// Имена head_group_name в sa.deals почти совпадают с метками листов; расхождения —
// в ALIASES. Группа, для которой в листе нет строки, попадает в строку
// «Другие товары (…)» листа (если есть), иначе — в служебную строку «Прочее (вне листа)».
export const GROUP_FAMILY: Record<string, ProductFamily> = {
  'Теплоизоляция и утеплитель': 'os', 'Газобетон': 'os', 'Плитные материалы': 'os', 'Ограждения и заборы': 'os',
  'Кровельные материалы, водосточные системы': 'os', 'Ондулин и шифер': 'os', 'Фасад': 'os', 'Разное': 'os',
  'Сухие смеси': 'os', 'Кирпич и другие стеновые материалы': 'os', 'Облицовочный кирпич': 'os', 'Гипсокартон': 'os',
  'Деревянная отделка': 'os', 'Пиломатериалы': 'os', 'Рулонная гидроизоляция': 'os', 'Окна и двери': 'os',
  'Изделия из поликарбоната': 'os', 'Сэндвич-панели': 'os', 'ЛКМ (Лакокрасочные материалы)': 'os',
  'Изделия для благоустройства': 'os', 'Напольные покрытия': 'os',
  'Щебень': 'nc', 'Песок': 'nc', 'Бетон и раствор': 'nc', 'Керамзит': 'nc', 'Вторичные материалы': 'nc',
  'Грунт и навоз': 'nc', 'Асфальт и асфальтобетон': 'nc', 'Аренда спецтехники': 'nc', 'Вывоз грунта и мусора': 'nc',
  'Уголь': 'nc', 'Сезонные товары': 'nc', 'ЩМА': 'nc', 'Перевозка': 'nc',
  'Дорожные плиты': 'zhbi', 'Плиты перекрытия ЖБИ': 'zhbi', 'ФБС': 'zhbi', 'Кольца ЖБИ': 'zhbi', 'Аэродромные плиты': 'zhbi',
  'Прочее ЖБИ': 'zhbi', 'Лотки и плиты лотков ЖБИ': 'zhbi', 'Опоры СВ': 'zhbi', 'Заборы ЖБИ': 'zhbi', 'Трубы ЖБИ': 'zhbi',
  'Сваи ЖБИ': 'zhbi', 'Лестничные марши и площадки': 'zhbi',
  'Арматура стальная и проволока': 'metal', 'Прочий металлопрокат': 'metal', 'Трубы профильные стальные': 'metal',
};

export function familyOf(headGroup: string | null): ProductFamily {
  if (!headGroup) return 'other';
  return GROUP_FAMILY[headGroup] ?? 'other';
}

/** head_group_name → возможные метки строк листа (первая найденная в листе — побеждает). */
const ALIASES: Record<string, string[]> = {
  'Бетон и раствор': ['Бетон'],
  'Кровельные материалы, водосточные системы': ['Кровельные материалы'],
  'Изделия для благоустройства': ['Благоустройство'],
  'Разное': ['Разное (другие материалы)'],
  'Сэндвич-панели': ['Сэндвич панели', 'Сендвич панели'],
  'Изделия из поликарбоната': ['Поликарбонат'],
  'Вывоз грунта и мусора': ['Вывоз грунта'],
  'Лотки и плиты лотков ЖБИ': ['Лотки и плиты лотков ЖБИ', 'Лотки ЖБИ'],
  'Трубы профильные стальные': ['Трубы профильные'],
  'Прочий металлопрокат': ['Прочий сортовой металлопрокат'],
  'Напольные покрытия': ['Деревянная отделка'],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/ё/g, 'е').trim();

/** Строка листа для товарной группы: точное имя → алиас → «Другие товары (…)» → null (вне листа). */
export function resolveSheetRowLabel(headGroup: string | null, sheetLabels: string[]): string | null {
  const byNorm = new Map(sheetLabels.map(l => [norm(l), l]));
  if (headGroup) {
    const direct = byNorm.get(norm(headGroup));
    if (direct) return direct;
    for (const a of ALIASES[headGroup] ?? []) {
      const hit = byNorm.get(norm(a));
      if (hit) return hit;
    }
  }
  const other = sheetLabels.find(l => /^другие товары/i.test(l));
  return other ?? null;
}

export const OUT_OF_SHEET_LABEL = 'Прочее (вне листа)';
