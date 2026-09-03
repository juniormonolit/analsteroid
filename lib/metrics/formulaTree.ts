// Дерево формулы calculated-метрики — для полноэкранного «Разбора метрики»
// (задача владельца 03.09): каждая ссылка [metric_id] становится операндом со
// своей живой выборкой сделок, операторы — узлами между ними. Пока формула
// считалась одной строкой через Function() (features/reports/engine/calculated.ts,
// evalFormula), показать её по частям было нечем.
//
// БЕЗ серверных импортов (pg/redis/next) — модуль импортирует клиентский код.
//
// Null-семантика evalFormulaTree НАМЕРЕННО совпадает с evalFormula: любая ссылка
// без значения (null/undefined) обнуляет весь результат, деление на ноль, NaN и
// ±Infinity тоже дают null. Иначе «Разбор» показывал бы число там, где сама
// таблица отчёта показывает прочерк, — и наоборот.
//
// Грамматика (стандартный приоритет, левая ассоциативность, унарный минус):
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := '-' unary | primary
//   primary := number | '[' id ']' | bare_id | '(' expr ')'
// bare_id — легаси-синтаксис без скобок (evalFormula подставлял известные id
// по вхождению). У «голого» идентификатора дефис НЕ считается частью имени,
// иначе `a-b` перестало бы быть вычитанием; внутри скобок дефис допустим.

export type FormulaOp = '+' | '-' | '*' | '/';

export type FormulaNode =
  | { kind: 'ref'; id: string }
  | { kind: 'num'; value: number }
  | { kind: 'op'; op: FormulaOp; left: FormulaNode; right: FormulaNode };

export type FormulaOpNode = Extract<FormulaNode, { kind: 'op' }>;

type Token =
  | { t: 'num'; value: number }
  | { t: 'ref'; id: string }
  | { t: 'op'; op: FormulaOp }
  | { t: 'lparen' }
  | { t: 'rparen' };

const BRACKET_ID_RE = /^[A-Za-z0-9_.-]+$/;
const OPS: ReadonlySet<string> = new Set(['+', '-', '*', '/']);

class ParseError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { out.push({ t: 'lparen' }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rparen' }); i++; continue; }
    if (OPS.has(ch)) { out.push({ t: 'op', op: ch as FormulaOp }); i++; continue; }
    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close < 0) throw new ParseError('unclosed [');
      const id = src.slice(i + 1, close).trim();
      if (!BRACKET_ID_RE.test(id)) throw new ParseError(`bad ref id: ${id}`);
      out.push({ t: 'ref', id });
      i = close + 1;
      continue;
    }
    // Число: целое или десятичное с точкой. `1.` и `.5` — не число (мусор → null).
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    // Голый идентификатор (легаси): буква/подчёркивание, далее буквы/цифры/_/точка.
    const bare = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (bare) {
      out.push({ t: 'ref', id: bare[0] });
      i += bare[0].length;
      continue;
    }
    throw new ParseError(`unexpected char: ${ch}`);
  }
  return out;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  // Не parameter property (`constructor(private tokens)`) — Node в режиме
  // strip-only не умеет её раскрывать, а assert-скрипт импортирует файл напрямую.
  constructor(tokens: Token[]) { this.tokens = tokens; }

  parse(): FormulaNode {
    const node = this.expr();
    if (this.pos !== this.tokens.length) throw new ParseError('trailing tokens');
    return node;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }

  private expr(): FormulaNode {
    let left = this.term();
    for (;;) {
      const tk = this.peek();
      if (tk?.t !== 'op' || (tk.op !== '+' && tk.op !== '-')) return left;
      this.pos++;
      left = { kind: 'op', op: tk.op, left, right: this.term() };
    }
  }

  private term(): FormulaNode {
    let left = this.unary();
    for (;;) {
      const tk = this.peek();
      if (tk?.t !== 'op' || (tk.op !== '*' && tk.op !== '/')) return left;
      this.pos++;
      left = { kind: 'op', op: tk.op, left, right: this.unary() };
    }
  }

  private unary(): FormulaNode {
    const tk = this.peek();
    if (tk?.t === 'op' && tk.op === '-') {
      this.pos++;
      const operand = this.unary();
      // В дереве нет унарного узла: минус перед числом складываем в само число,
      // перед чем угодно другим — записываем как `0 − x` (та же null-протяжка).
      if (operand.kind === 'num') return { kind: 'num', value: -operand.value };
      return { kind: 'op', op: '-', left: { kind: 'num', value: 0 }, right: operand };
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    const tk = this.peek();
    if (!tk) throw new ParseError('unexpected end');
    this.pos++;
    if (tk.t === 'num') return { kind: 'num', value: tk.value };
    if (tk.t === 'ref') return { kind: 'ref', id: tk.id };
    if (tk.t === 'lparen') {
      const inner = this.expr();
      if (this.peek()?.t !== 'rparen') throw new ParseError('expected )');
      this.pos++;
      return inner;
    }
    throw new ParseError(`unexpected token ${tk.t}`);
  }
}

/** Разбор формулы каталога в дерево. Любая ошибка разбора → null, не бросает. */
export function parseFormula(formula: string): FormulaNode | null {
  try {
    const tokens = tokenize(formula);
    if (tokens.length === 0) return null;
    return new Parser(tokens).parse();
  } catch {
    return null;
  }
}

/** Вычисление дерева с null-протяжкой как в evalFormula (см. шапку файла). */
export function evalFormulaTree(
  node: FormulaNode,
  values: Record<string, number | null | undefined>,
): number | null {
  if (node.kind === 'num') return Number.isFinite(node.value) ? node.value : null;
  if (node.kind === 'ref') {
    const v = values[node.id];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  const l = evalFormulaTree(node.left, values);
  if (l === null) return null;
  const r = evalFormulaTree(node.right, values);
  if (r === null) return null;
  let result: number;
  switch (node.op) {
    case '+': result = l + r; break;
    case '-': result = l - r; break;
    case '*': result = l * r; break;
    case '/':
      if (r === 0) return null;
      result = l / r;
      break;
  }
  return Number.isFinite(result) ? result : null;
}

/** Уникальные id ссылок в порядке появления (слева направо). */
export function formulaRefs(node: FormulaNode): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (n: FormulaNode) => {
    if (n.kind === 'ref') {
      if (!seen.has(n.id)) { seen.add(n.id); out.push(n.id); }
      return;
    }
    if (n.kind === 'op') { walk(n.left); walk(n.right); }
  };
  walk(node);
  return out;
}

const OP_RU: Record<FormulaOp, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' };

/** Человеческий знак оператора: минус, крестик и обелюс вместо ASCII. */
export function formatOp(op: FormulaOp): string {
  return OP_RU[op];
}

const PRECEDENCE: Record<FormulaOp, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/**
 * Нужны ли скобки вокруг ребёнка при печати/рендере под данным родителем.
 * Ребёнок с более низким приоритетом — всегда в скобках; с более высоким — никогда.
 * При равном приоритете левый операнд скобок не требует (левая ассоциативность),
 * правый — требует, если родитель не ассоциативен (a − (b − c) ≠ a − b − c) или
 * если внутри другой оператор той же ступени: a + (b − c) без скобок перепарсится
 * в (a + b) − c — то же число, но уже не то дерево, что записал автор формулы.
 */
export function needsParens(parent: FormulaOpNode, child: FormulaNode, side: 'left' | 'right'): boolean {
  if (child.kind !== 'op') return false;
  const pp = PRECEDENCE[parent.op];
  const cp = PRECEDENCE[child.op];
  if (cp < pp) return true;
  if (cp > pp) return false;
  if (side === 'left') return false;
  return parent.op === '-' || parent.op === '/' || child.op !== parent.op;
}
