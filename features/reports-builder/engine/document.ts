// Модель документа отчёта и её рендер в BB-код.
//
// Вёрстка всех отчётов владельца одинакова и держится на двух отступах:
//   - блоки внутри секции разделены ПУСТОЙ строкой;
//   - секции разделены «————» на отдельной строке, вплотную к следующей секции
//     (пустая строка только СВЕРХУ разделителя).
// Раньше это правило существовало в виде трёх одинаковых `.join('\n\n————\n')`
// в трёх файлах — стоило кому-то поставить пробел иначе, и отчёт в чате
// разъезжался. Теперь правило одно и живёт здесь.

/** Блок: необязательный жирный заголовок + строки. Пустая строка в lines — намеренный отступ. */
export interface Block {
  title?: string;
  lines: string[];
}

/** Секция: блоки через пустую строку. */
export type Section = Block[];

/** Документ: секции через «————». */
export type ReportDocument = Section[];

export const SECTION_SEPARATOR = '————';

export function renderBlock(block: Block): string {
  const lines = block.title !== undefined ? [`[b]${block.title}[/b]`, ...block.lines] : block.lines;
  return lines.join('\n');
}

export function renderSection(section: Section): string {
  return section.map(renderBlock).join('\n\n');
}

export function renderDocument(doc: ReportDocument): string {
  return doc.map(renderSection).join(`\n\n${SECTION_SEPARATOR}\n`);
}

/** Строка «Показатель — значение» — базовый кирпич всех отчётов. */
export function metricRow(label: string, value: string): string {
  return `${label} — ${value}`;
}
