// Модель документа отчёта и её рендер в BB-код.
//
// Вёрстка всех отчётов владельца одинакова и держится на двух отступах:
//   - блоки внутри секции разделены ПУСТОЙ строкой;
//   - секции разделены «————» на отдельной строке, вплотную к следующей секции
//     (пустая строка только СВЕРХУ разделителя).
// Раньше это правило существовало в виде трёх одинаковых `.join('\n\n————\n')`
// в трёх файлах — стоило кому-то поставить пробел иначе, и отчёт в чате
// разъезжался. Теперь правило одно и живёт здесь.
//
// Строка бывает двух видов: готовый текст и СТРУКТУРНАЯ — «подпись + значение».
// Второй вид нужен анимации сборки: цифра должна докручиваться от нуля к
// значению, а из готовой строки её обратно не вырезать (и не надо: парсить
// собственный вывод регуляркой — верный способ однажды поймать «7,1» в слове).

import { formatValue, type MetricValue, type ValueFormat } from './format';

export interface StructuredLine {
  /** Всё до значения: «План продаж — », «% ПЛАНА (ДЕНЬ) — ». */
  prefix: string;
  value: MetricValue;
  format: ValueFormat;
  /** Всё после значения (обычно пусто). */
  suffix?: string;
}

export type Line = string | StructuredLine;

export function isStructured(line: Line): line is StructuredLine {
  return typeof line !== 'string';
}

export function renderLine(line: Line): string {
  if (!isStructured(line)) return line;
  return `${line.prefix}${formatValue(line.value, line.format)}${line.suffix ?? ''}`;
}

/** Блок: необязательный жирный заголовок + строки. Пустая строка в lines — намеренный отступ. */
export interface Block {
  title?: Line;
  lines: Line[];
}

/** Секция: блоки через пустую строку. */
export type Section = Block[];

/** Документ: секции через «————». */
export type ReportDocument = Section[];

export const SECTION_SEPARATOR = '————';

export function renderBlock(block: Block): string {
  const lines = block.title !== undefined
    ? [`[b]${renderLine(block.title)}[/b]`, ...block.lines.map(renderLine)]
    : block.lines.map(renderLine);
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

/** То же, но со значением, которое анимация умеет докручивать. */
export function metricLine(label: string, value: MetricValue, format: ValueFormat): StructuredLine {
  return { prefix: `${label} — `, value, format };
}
