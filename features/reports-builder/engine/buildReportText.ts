// Движок конструктора отчётов: состояние + данные → BB-код.
//
// Чистая функция без БД, сети и дат «сейчас» — всё считается снаружи и приходит
// готовыми числами. Это условие спеки (REPORT_CONSTRUCTOR_SPEC.md, шаг 1):
// движок обязан воспроизводить три существующих формата БАЙТ-В-БАЙТ, а проверить
// это можно только на синтетических числах, без похода в Битрикс.
// Проверка — scripts/assert-report-engine.ts (дифф против дословных копий
// старых рендереров).
//
// Формат отчёта «МОСКВА» (lib/jobs/dailyMoscowReport.ts) — источник правды
// структуры; «КОВАЛЕНКО» (lib/jobs/dailyGroupReport.ts) отличается ровно тремя
// параметрами (подзаголовок с днём недели, точность процентов, отсутствие блоков
// по сущностям), а не другим шаблоном.

import {
  fmtDateRu,
  weekdayRu,
  type MetricValue,
  type ValueFormat,
} from './format';
import {
  metricLine,
  renderDocument,
  type Block,
  type Line,
  type ReportDocument,
  type Section,
} from './document';

/** Ключ итоговой (агрегированной) колонки в наборах значений. */
export const TOTAL = '__total__';

export interface ReportEntity {
  /** Стабильный ключ — им адресуются значения метрик. */
  key: string;
  /** Подпись в разбивке: «Общестрой», «Осипов». */
  title: string;
  /** Заголовок блока сущности. По умолчанию — title заглавными. */
  blockTitle?: string;
}

export interface ReportMetric {
  /** «План продаж», «Конверсия в бронь (месяц)». */
  label: string;
  format: ValueFormat;
  /** Значения по ключу сущности; TOTAL — итог по всем. */
  values: Record<string, MetricValue>;
  /** Пустая строка перед метрикой — отбивка смысловых групп внутри блока. */
  gapBefore?: boolean;
}

export type SubtitleSpec =
  /** «за 05.08.2026», с prefix — «Общестрой · за 05.08.2026». */
  | { style: 'za'; date: string; prefix?: string | null }
  /** «Вторник, 05.08.2026» — так просил владелец отдела в отчёте КОВАЛЕНКО. */
  | { style: 'weekday'; date: string };

export interface ReportSpec {
  /** «Отчет МОСКВА», «Отчет: Иван Иванов». */
  title: string;
  subtitle: SubtitleSpec;
  entities: ReportEntity[];
  /**
   * Сводные секции «метрика — итог + разбивка по сущностям».
   * Каждый вложенный массив — отдельная секция (в «МОСКВЕ» их две: проценты
   * плана и конверсии).
   */
  overview?: ReportMetric[][];
  /** Метрики блока сущности. Пусто → блоков по сущностям нет (отчёт КОВАЛЕНКО). */
  entityBlock?: ReportMetric[];
  /**
   * Итоговый блок. Метрики по умолчанию — те же, что в блоке сущности; свои
   * нужны, когда у итога другой формат (КОВАЛЕНКО считает итог в рублях).
   * Отсутствует в личном отчёте из одной сущности — правило владельца
   * «агрегат везде, кроме личного».
   */
  aggregate?: { title: string; metrics?: ReportMetric[] };
}

function renderSubtitle(s: SubtitleSpec): string {
  if (s.style === 'weekday') return `${weekdayRu(s.date)}, ${fmtDateRu(s.date)}`;
  return `${s.prefix ? `${s.prefix} · ` : ''}за ${fmtDateRu(s.date)}`;
}

export function headerBlock(title: string, subtitle: SubtitleSpec): Block {
  return { title, lines: [`[i]${renderSubtitle(subtitle)}[/i]`] };
}

/** Сводный блок: «[b]Метрика — итог[/b]» + строка на каждую сущность. */
function overviewBlock(metric: ReportMetric, entities: ReportEntity[]): Block {
  return {
    title: metricLine(metric.label, metric.values[TOTAL] ?? null, metric.format),
    lines: entities.map(e => metricLine(e.title, metric.values[e.key] ?? null, metric.format)),
  };
}

/** Блок одной колонки (сущности или итога): все метрики подряд. */
function columnBlock(title: string, metrics: ReportMetric[], columnKey: string): Block {
  const lines: Line[] = [];
  for (const m of metrics) {
    if (m.gapBefore) lines.push('');
    lines.push(metricLine(m.label, m.values[columnKey] ?? null, m.format));
  }
  return { title, lines };
}

export function buildReportDocument(spec: ReportSpec): ReportDocument {
  const { entities, overview = [], entityBlock = [], aggregate } = spec;
  const doc: ReportDocument = [];

  // Шапка живёт в одной секции с первой сводной группой — так во всех трёх
  // эталонах: разделитель идёт только перед конверсиями, а не после даты.
  const [firstOverview, ...restOverview] = overview;
  doc.push([
    headerBlock(spec.title, spec.subtitle),
    ...(firstOverview ?? []).map(m => overviewBlock(m, entities)),
  ]);

  for (const group of restOverview) {
    doc.push(group.map(m => overviewBlock(m, entities)));
  }

  if (entityBlock.length > 0) {
    const section: Section = entities.map(e =>
      columnBlock(e.blockTitle ?? e.title.toUpperCase(), entityBlock, e.key),
    );
    doc.push(section);
  }

  if (aggregate) {
    doc.push([columnBlock(aggregate.title, aggregate.metrics ?? entityBlock, TOTAL)]);
  }

  return doc;
}

export function buildReportText(spec: ReportSpec): string {
  return renderDocument(buildReportDocument(spec));
}
