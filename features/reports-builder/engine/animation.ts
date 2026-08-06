// План анимированной сборки отчёта.
//
// Требования владельца (REPORT_CONSTRUCTOR_SPEC.md, «АНИМИРОВАННАЯ СБОРКА»):
//   * строки собираются ПО СЛОВАМ, не посимвольно;
//   * числа докручиваются ОТ НУЛЯ вверх (0→87%), а не мельтешат случайными
//     цифрами: рост читается как «считается», шум — как глюк;
//   * крутится только число, подпись стоит на месте;
//   * разделители «————» появляются мгновенно — это структура, а не данные;
//   * ПРОПУСКА НЕТ, поэтому общее время — жёсткое обязательство: длинный отчёт
//     сжимает шаг между словами, а не растягивает ожидание.
//
// Файл чистый: ни React, ни таймеров. План — это «что показать на момент t»,
// а кто крутит часы (rAF в хуке или тест) — его дело. Иначе анимацию нельзя
// проверить, не запуская браузер.

import { formatValue, isRatio, type MetricValue, type ValueFormat } from './format';
import {
  isStructured,
  renderLine,
  SECTION_SEPARATOR,
  type Line,
  type ReportDocument,
} from './document';

// ── Тайминги ───────────────────────────────────────────────────────────────────────

export const TIMING = {
  /** Шаг между словами внутри строки. */
  wordMs: 28,
  /** Пауза между строками. */
  lineMs: 60,
  /** Докрутка числа от нуля к значению. */
  rollMs: 380,
  /** Потолок на весь отчёт: пропустить нельзя, значит ждать полминуты нельзя тоже. */
  budgetMs: 20_000,
} as const;

// ── Токены ─────────────────────────────────────────────────────────────────────────

export interface Token {
  /** Пробелы перед словом — хранятся, чтобы склейка давала ИСХОДНУЮ строку. */
  sep: string;
  text: string;
  /** Значение метрики: этот токен появляется целиком и докручивается. */
  value?: { value: MetricValue; format: ValueFormat };
}

/**
 * Режет строку на слова, но значение метрики держит ОДНИМ токеном, даже если в
 * нём есть пробелы («11,3 млн», «1 234 567 ₽»). Иначе «млн» приезжало бы
 * отдельным словом уже после того, как число докрутилось.
 */
function tokenize(full: string, value?: { start: number; length: number; part: Token['value'] }): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < full.length) {
    const sepStart = i;
    while (i < full.length && full[i] === ' ') i++;
    const sep = full.slice(sepStart, i);
    if (i >= full.length) {
      // Хвостовые пробелы: приклеиваем к последнему токену, чтобы склейка совпала.
      if (tokens.length > 0) tokens[tokens.length - 1].text += sep;
      break;
    }
    if (value && i === value.start) {
      tokens.push({ sep, text: full.slice(value.start, value.start + value.length), value: value.part });
      i = value.start + value.length;
      continue;
    }
    const wordStart = i;
    while (i < full.length && full[i] !== ' ' && !(value && i === value.start)) i++;
    tokens.push({ sep, text: full.slice(wordStart, i) });
  }
  return tokens;
}

export function joinTokens(tokens: Token[], count = tokens.length): string {
  return tokens.slice(0, count).map(t => t.sep + t.text).join('');
}

// ── План ───────────────────────────────────────────────────────────────────────────

export interface PlannedLine {
  tokens: Token[];
  /** Разделители и пустые строки — без анимации. */
  instant: boolean;
  /** Момент появления первого слова, мс от старта. */
  startMs: number;
  /** Момент, когда строка собрана полностью. */
  endMs: number;
}

export interface AnimationPlan {
  lines: PlannedLine[];
  totalMs: number;
  /** Во сколько раз пришлось ускориться, чтобы уложиться в бюджет (1 = не пришлось). */
  speedUp: number;
}

function lineToTokens(line: Line, bold: boolean): Token[] {
  const inner = renderLine(line);
  const full = bold ? `[b]${inner}[/b]` : inner;
  if (!isStructured(line)) return tokenize(full);
  const valueStr = formatValue(line.value, line.format);
  const start = (bold ? 3 : 0) + line.prefix.length;
  return tokenize(full, {
    start,
    length: valueStr.length,
    part: { value: line.value, format: line.format },
  });
}

/** Плоский список строк документа — ровно тот, что даёт renderDocument. */
function flattenLines(doc: ReportDocument): { tokens: Token[]; instant: boolean }[] {
  const out: { tokens: Token[]; instant: boolean }[] = [];
  doc.forEach((section, si) => {
    if (si > 0) {
      out.push({ tokens: tokenize(''), instant: true });
      out.push({ tokens: tokenize(SECTION_SEPARATOR), instant: true });
    }
    section.forEach((block, bi) => {
      if (bi > 0) out.push({ tokens: tokenize(''), instant: true });
      if (block.title !== undefined) out.push({ tokens: lineToTokens(block.title, true), instant: false });
      for (const line of block.lines) {
        const tokens = lineToTokens(line, false);
        out.push({ tokens, instant: tokens.length === 0 });
      }
    });
  });
  return out;
}

export function buildAnimationPlan(doc: ReportDocument, timing = TIMING): AnimationPlan {
  const flat = flattenLines(doc);

  // Первый проход — «как хотелось бы», без оглядки на бюджет.
  let t = 0;
  const raw = flat.map(({ tokens, instant }) => {
    const startMs = t;
    if (instant) return { tokens, instant, startMs, endMs: t };
    const reveal = Math.max(0, tokens.length - 1) * timing.wordMs;
    const hasValue = tokens.some(tok => tok.value);
    const endMs = startMs + reveal + (hasValue ? timing.rollMs : 0);
    t = endMs + timing.lineMs;
    return { tokens, instant, startMs, endMs };
  });
  const naturalMs = raw.length > 0 ? Math.max(...raw.map(l => l.endMs)) : 0;

  // Второй проход — сжатие. Ускоряем ВСЁ пропорционально: сокращать что-то одно
  // (например только паузы) означает получить рваный ритм на длинных отчётах.
  const speedUp = naturalMs > timing.budgetMs ? naturalMs / timing.budgetMs : 1;
  const lines = raw.map(l => ({ ...l, startMs: l.startMs / speedUp, endMs: l.endMs / speedUp }));

  return { lines, totalMs: naturalMs / speedUp, speedUp };
}

// ── Состояние на момент t ──────────────────────────────────────────────────────────

/** Плавное замедление в конце докрутки — иначе число «втыкается» в значение. */
function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}

function rolledValue(value: MetricValue, progress: number): MetricValue {
  if (progress >= 1 || value === null) return value;
  const k = easeOut(Math.max(0, progress));
  // Доля: крутим ЧИСЛИТЕЛЬ при неподвижном знаменателе — так 0%→87% растёт
  // равномерно, а не прыгает через деление на растущий знаменатель.
  if (isRatio(value)) return { num: value.num * k, den: value.den };
  return value * k;
}

/**
 * Текст отчёта на момент elapsed. Возвращает те же строки, что и renderDocument,
 * но обрезанные по фронту появления.
 */
export function renderPlanAt(plan: AnimationPlan, elapsedMs: number, timing = TIMING): string[] {
  const wordMs = timing.wordMs / plan.speedUp;
  const rollMs = timing.rollMs / plan.speedUp;
  const out: string[] = [];

  for (const line of plan.lines) {
    if (elapsedMs < line.startMs) break; // дальше ещё ничего не появилось
    if (line.instant || elapsedMs >= line.endMs) {
      out.push(joinTokens(line.tokens));
      continue;
    }
    const since = elapsedMs - line.startMs;
    const shown = Math.min(line.tokens.length, Math.floor(since / wordMs) + 1);
    let text = '';
    for (let i = 0; i < shown; i++) {
      const tok = line.tokens[i];
      if (!tok.value) { text += tok.sep + tok.text; continue; }
      // Докрутка стартует, когда токен-значение появился.
      const rollStart = i * wordMs;
      const progress = rollMs > 0 ? (since - rollStart) / rollMs : 1;
      text += tok.sep + formatValue(rolledValue(tok.value.value, progress), tok.value.format);
    }
    out.push(text);
  }
  return out;
}

/** Готовый текст — он же то, что уйдёт в буфер обмена. */
export function renderPlanFull(plan: AnimationPlan): string {
  return plan.lines.map(l => joinTokens(l.tokens)).join('\n');
}
