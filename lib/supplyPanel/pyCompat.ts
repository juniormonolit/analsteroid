/**
 * Python-совместимые примитивы для порта Панели снабжения (расчёт обязан совпадать с Python побитово).
 *  - pyRound: round(x[, n]) по правилам CPython (точное десятичное значение double, при точной ничьей — к чётному);
 *  - pySetOrder: порядок обхода set[int] в CPython 3.9 (нужен, потому что sum() по float зависит от порядка слагаемых);
 *  - cmpStr: сравнение строк по кодовым точкам (JS < сравнивает UTF-16), median, norm-пробелы Python.
 */

/** round(x) без ndigits: округление к ближайшему целому, ничья — к чётному. */
export function pyRound0(x: number): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const d = x - f; // точно: x и f — double одного порядка
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** round(x, n) для n >= 1: как float.__round__ в CPython. */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const a = Math.abs(x);
  if (a >= 1e15) return x;
  const scale = 10 ** n;
  const t = a * scale * 2;
  // быстрая проверка: далеко от «точки ничьей» — достаточно toFixed (оно точное для не-ничьих)
  if (Math.abs(t - Math.round(t)) < 1e-6 && Math.round(t) % 2 === 1) {
    const s = a.toFixed(100);
    const dot = s.indexOf('.');
    const frac = s.slice(dot + 1);
    if (frac[n] === '5' && /^0*$/.test(frac.slice(n + 1))) {
      // точная ничья: к чётной последней цифре
      const kept = s.slice(0, dot) + frac.slice(0, n);
      const lastDigit = Number(kept[kept.length - 1]);
      let digits = kept.split('');
      if (lastDigit % 2 === 1) { // прибавить единицу в десятичной записи
        let i = digits.length - 1;
        while (i >= 0 && digits[i] === '9') { digits[i] = '0'; i--; }
        if (i >= 0) digits[i] = String(Number(digits[i]) + 1); else digits = ['1', ...digits];
      }
      const str = digits.join('').padStart(n + 1, '0');
      const res = Number(str.slice(0, str.length - n) + '.' + str.slice(str.length - n));
      return x < 0 ? -res : res;
    }
  }
  const r = Number(a.toFixed(n));
  return x < 0 ? -r : r;
}

/** Строки как в Python: по кодовым точкам. Возвращает <0, 0, >0. */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  // без суррогатов порядок UTF-16 и кодовых точек совпадает
  if (!/[\ud800-\udfff]/.test(a) && !/[\ud800-\udfff]/.test(b)) return a < b ? -1 : 1;
  const x = Array.from(a), y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i]!.codePointAt(0)!, q = y[i]!.codePointAt(0)!;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

export function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** statistics.median (Python 3.9): для чётного n — (a[i-1] + a[i]) / 2. */
export function pyMedian(xs: number[]): number {
  const d = xs.slice().sort(cmpNum);
  const n = d.length, i = n >> 1;
  return n % 2 === 1 ? d[i]! : (d[i - 1]! + d[i]!) / 2;
}

/** Пробельные символы, как у str.isspace / re \s в Python. */
export const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS_RUN = new RegExp(`[${PY_WS}]+`, 'g');
const WS_EDGE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');

/** re.sub(r"\s+", " ", (s or "").lower().replace("ё", "е")).strip() */
export function pyNorm(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/ё/g, 'е').replace(WS_RUN, ' ').replace(WS_EDGE, '');
}

/**
 * Порядок обхода set[int] в CPython 3.9 при добавлении элементов по одному в порядке `inserted`
 * (элементы уникальны, неотрицательные, < 2^53; hash(int) = int).
 */
export function pySetOrder(inserted: number[]): number[] {
  const LINEAR = 9;
  let size = 8;
  let table: (number | undefined)[] = new Array(size);
  let fill = 0;

  const insertClean = (tbl: (number | undefined)[], sz: number, h: number): void => {
    let perturb = h;
    let i = h % sz;
    for (;;) {
      if (tbl[i] === undefined) { tbl[i] = h; return; }
      if (i + LINEAR <= sz - 1) {
        for (let j = 1; j <= LINEAR; j++) {
          if (tbl[i + j] === undefined) { tbl[i + j] = h; return; }
        }
      }
      perturb = Math.floor(perturb / 32);
      i = (i * 5 + 1 + perturb) % sz;
    }
  };

  for (const h of inserted) {
    const mask = size - 1;
    let i = h % size;
    let placed = false;
    if (table[i] === undefined) { table[i] = h; placed = true; }
    else {
      let perturb = h;
      while (!placed) {
        if (i + LINEAR <= mask) {
          for (let j = 1; j <= LINEAR; j++) {
            if (table[i + j] === undefined) { table[i + j] = h; placed = true; break; }
          }
          if (placed) break;
        }
        perturb = Math.floor(perturb / 32);
        i = (i * 5 + 1 + perturb) % size;
        if (table[i] === undefined) { table[i] = h; placed = true; }
      }
    }
    fill++;
    if (fill * 5 >= mask * 3) {
      const minused = fill > 50000 ? fill * 2 : fill * 4;
      let ns = 8;
      while (ns <= minused) ns *= 2;
      const nt: (number | undefined)[] = new Array(ns);
      for (const e of table) if (e !== undefined) insertClean(nt, ns, e);
      table = nt;
      size = ns;
    }
  }
  const out: number[] = [];
  for (const e of table) if (e !== undefined) out.push(e);
  return out;
}

/** Python: f"{x}" для None и чисел в строке «id …». */
export function pyStr(v: unknown): string {
  return v === null || v === undefined ? 'None' : String(v);
}
