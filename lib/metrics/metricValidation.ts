import { isSqlIdent } from './sqlGen';

// Проверка определения метрики на записи из админки (POST/PUT /api/admin/metrics,
// аудит 29.09, #8256, находка D3). Те же правила, что держит sqlGen при сборке
// SQL: имена — SQL-идентификаторы, op — из списка, value — скаляр или массив
// скаляров. Возвращает текст ошибки для 400 или null.
const OPS = ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null', 'gt_field', 'gt_field_or_null'];

function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

export function metricDefinitionError(body: Record<string, unknown>, opts: { requireId: boolean }): string | null {
  if (opts.requireId && !isSqlIdent(body.id)) {
    return 'id метрики: только латиница, цифры и «_», начинается с буквы или «_», до 63 символов';
  }
  for (const key of ['agg_field', 'date_field'] as const) {
    const v = body[key];
    if (v !== undefined && v !== null && v !== '' && !isSqlIdent(v)) return `${key}: ожидается имя колонки`;
  }
  const filters = body.filters;
  if (filters === undefined || filters === null) return null;
  if (!Array.isArray(filters)) return 'filters: ожидается массив';
  for (const [i, raw] of filters.entries()) {
    const f = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
    if (!f) return `filters[${i}]: ожидается объект`;
    if (!isSqlIdent(f.field)) return `filters[${i}].field: ожидается имя колонки`;
    if (typeof f.op !== 'string' || !OPS.includes(f.op)) return `filters[${i}].op: недопустимый оператор`;
    const v = f.value;
    const ok = v === undefined || v === null || isScalar(v) || (Array.isArray(v) && v.every(isScalar));
    if (!ok) return `filters[${i}].value: только строка, число, логическое значение или их массив`;
  }
  return null;
}
