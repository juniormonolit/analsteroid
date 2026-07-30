// Разбор фильтра «Чек от/до» из тела запроса графиков (задача 30.07, владелец:
// «фильтр по сумме сделки, чтобы можно было выставить "Чек От или до"»).
// Общий для всех 8 роутов раздела «Графики» (4 графика + 4 дрилл-дауна) —
// один источник правды на валидацию, как buildProductGroupFilter на SQL.
// Пустое/отсутствующее значение = без ограничения (поведение по умолчанию не
// меняется). Сами SQL-условия — amountWhere в stageSurvival.ts (поле d.amount).

export type AmountRange =
  | { ok: true; amountFrom?: number; amountTo?: number }
  | { ok: false; error: string };

const MAX_AMOUNT = 1e12; // санитарный потолок — суммы сделок на порядки меньше

function parseOne(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return null; // null = невалидно
  return n;
}

export function parseAmountRange(body: Record<string, unknown>): AmountRange {
  const from = parseOne(body.amountFrom);
  const to = parseOne(body.amountTo);
  if (from === null || to === null) {
    return { ok: false, error: 'amountFrom/amountTo должны быть неотрицательными числами' };
  }
  if (from !== undefined && to !== undefined && from > to) {
    return { ok: false, error: 'amountFrom не может быть больше amountTo' };
  }
  return { ok: true, amountFrom: from, amountTo: to };
}
