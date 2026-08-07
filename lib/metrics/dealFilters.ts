import type { PoolClient } from 'pg';

// «Фильтр сделок» (задача владельца 07.08.2026) — условия, которые режут САМ
// НАБОР СДЕЛОК, попадающих в отчёт, до расчёта любых метрик.
//
// Юзкейс владельца: «РОП видит конверсию по утеплителю 15 % и строит гипотезу,
// что она снизилась из-за мелких чеков. Как проверить: построить отчёт только из
// сделок с чеком выше 50, 70 тыс и посмотреть, меняется ли конверсия». Ключевое
// здесь — фильтр режет и числитель, и знаменатель конверсии одинаково, поэтому
// вопрос вообще имеет смысл. Фильтр ОДНОЙ метрики (filters в каталоге) так не
// умеет: он ограничивает только свою метрику.
//
// Механика — та же, что у экспериментальных фильтров нерабочего времени
// (lib/metrics/offHoursFilters.ts, задача 1569): строим WHERE-фрагмент, движки
// подмешивают его в общий запрос сделок И ОБЯЗАТЕЛЬНО кладут в ключ кэша строк
// (иначе отфильтрованные строки протекут в нефильтрованный отчёт и наоборот).
//
// ── Про безопасность ─────────────────────────────────────────────────────────
// Значения приходят ОТ ПОЛЬЗОВАТЕЛЯ, в отличие от filters каталога метрик (их
// пишет админ в настройках). Поэтому здесь, в отличие от
// sqlGen.ts::resolveFilterClause, нельзя просто подставить значение в строку:
//   * поле обязано быть из белого списка FIELDS ниже (никаких произвольных имён
//     колонок — иначе `d.<что угодно>` и утечка соседних данных);
//   * оператор — из белого списка, разрешённого для типа поля;
//   * число → через Number() с проверкой на конечность;
//   * дата → строгий формат YYYY-MM-DD;
//   * строка → одинарные кавычки удваиваются (стандартное экранирование
//     литерала Postgres при standard_conforming_strings=on, он включён по
//     умолчанию) + ограничение длины.
// Списки значений ограничены по размеру — чтобы фильтр не превратился в способ
// сгенерировать мегабайтный SQL.

export type DealFilterOp =
  | 'eq' | 'neq' | 'in' | 'not_in'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  | 'is_null' | 'is_not_null';

export interface DealFilter {
  field: string;
  op: DealFilterOp;
  /** Для between — [от, до]; для in/not_in — массив; иначе скаляр. */
  value?: string | number | (string | number)[] | null;
}

type FieldKind = 'number' | 'date' | 'text' | 'int';

interface FieldDef {
  /** Колонка в sa.deals. */
  column: string;
  kind: FieldKind;
  label: string;
  /** Справочник значений для пикера (см. dealFilterOptions ниже). */
  options?: 'funnels' | 'stages' | 'head_groups' | 'sources';
  /** Псевдополе: своё SQL-выражение вместо d.<column> (тип клиента = воронка). */
  customSql?: (op: DealFilterOp, values: string[]) => string;
}

const NUM_OPS: DealFilterOp[] = ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq'];
const SET_OPS: DealFilterOp[] = ['in', 'not_in', 'eq', 'neq', 'is_null', 'is_not_null'];
const DATE_OPS: DealFilterOp[] = ['gte', 'lte', 'between'];

// ЮЛ/ФЛ определяются номером воронки — ровно так же, как funnel_type b2b/b2c в
// sqlGen.ts::resolveFilterClause. Держим ту же карту, а не заводим вторую правду.
const B2C_FUNNELS = [0, 2];
const B2B_FUNNELS = [1, 3];

export const DEAL_FILTER_FIELDS: Record<string, FieldDef> = {
  amount:          { column: 'amount',          kind: 'number', label: 'Сумма сделки, ₽' },
  head_group_name: { column: 'head_group_name', kind: 'text',   label: 'Товарная группа', options: 'head_groups' },
  funnel_id:       { column: 'funnel_id',       kind: 'int',    label: 'Воронка',         options: 'funnels' },
  stage_id:        { column: 'stage_id',        kind: 'text',   label: 'Стадия',          options: 'stages' },
  source_id:       { column: 'source_id',       kind: 'text',   label: 'Источник',        options: 'sources' },
  created_at:      { column: 'created_at',      kind: 'date',   label: 'Дата создания сделки' },
  client_kind:     {
    column: 'funnel_id', kind: 'text', label: 'Тип клиента (ЮЛ/ФЛ)',
    customSql: (op, values) => {
      const ids = values.flatMap(v => v === 'b2b' ? B2B_FUNNELS : v === 'b2c' ? B2C_FUNNELS : []);
      if (ids.length === 0) return '';
      const list = ids.join(', ');
      return op === 'neq' || op === 'not_in'
        ? `d.funnel_id NOT IN (${list})`
        : `d.funnel_id IN (${list})`;
    },
  },
};

export function opsForField(field: string): DealFilterOp[] {
  const def = DEAL_FILTER_FIELDS[field];
  if (!def) return [];
  if (def.customSql) return ['eq', 'neq'];
  if (def.kind === 'number' || def.kind === 'int') return def.options ? SET_OPS : NUM_OPS;
  if (def.kind === 'date') return DATE_OPS;
  return SET_OPS;
}

const MAX_FILTERS = 20;
const MAX_LIST = 200;
const MAX_STR = 200;

function sqlNumber(v: unknown): string | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.').trim());
  return Number.isFinite(n) ? String(n) : null;
}
function sqlDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `'${s}'` : null;
}
function sqlText(v: unknown): string | null {
  const s = String(v ?? '');
  if (s.length === 0 || s.length > MAX_STR) return null;
  return `'${s.replace(/'/g, "''")}'`;
}

function litFor(kind: FieldKind, v: unknown): string | null {
  if (kind === 'number' || kind === 'int') return sqlNumber(v);
  if (kind === 'date') return sqlDate(v);
  return sqlText(v);
}

/** Один фильтр → SQL-условие. Невалидный фильтр даёт '' и молча пропускается —
 *  так же ведёт себя resolveFilterClause: наполовину применённый фильтр опаснее
 *  непримененного, а форму условий валидирует UI и роут до этого места. */
function clauseFor(f: DealFilter): string {
  const def = DEAL_FILTER_FIELDS[f.field];
  if (!def) return '';
  if (!opsForField(f.field).includes(f.op)) return '';
  const col = `d.${def.column}`;

  if (def.customSql) {
    const vals = (Array.isArray(f.value) ? f.value : [f.value]).map(v => String(v ?? ''));
    return def.customSql(f.op, vals.slice(0, MAX_LIST));
  }
  if (f.op === 'is_null') return `${col} IS NULL`;
  if (f.op === 'is_not_null') return `${col} IS NOT NULL`;

  if (f.op === 'between') {
    if (!Array.isArray(f.value) || f.value.length !== 2) return '';
    const a = litFor(def.kind, f.value[0]);
    const b = litFor(def.kind, f.value[1]);
    if (a === null || b === null) return '';
    // Для даты верхняя граница включительная по дню: < следующего дня было бы
    // честнее, но created_at сравнивается с датой без времени — Postgres сам
    // приводит '2026-07-31' к полуночи, поэтому берём < дата+1 день.
    return def.kind === 'date'
      ? `(${col} >= ${a} AND ${col} < ${b}::date + 1)`
      : `${col} BETWEEN ${a} AND ${b}`;
  }
  if (f.op === 'in' || f.op === 'not_in') {
    const arr = (Array.isArray(f.value) ? f.value : [f.value]).slice(0, MAX_LIST);
    const lits = arr.map(v => litFor(def.kind, v)).filter((x): x is string => x !== null);
    if (lits.length === 0) return '';
    return `${col} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${lits.join(', ')})`;
  }

  const lit = litFor(def.kind, Array.isArray(f.value) ? f.value[0] : f.value);
  if (lit === null) return '';
  const opSql = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op as 'eq'];
  if (!opSql) return '';
  // Дата с lte — включительно по дню (см. комментарий про between выше).
  if (def.kind === 'date' && f.op === 'lte') return `${col} < ${lit}::date + 1`;
  return `${col} ${opSql} ${lit}`;
}

/**
 * Фильтры → WHERE-фрагмент (AND между условиями) + ключ для кэша строк.
 * Пустой фильтр даёт пустую строку и ключ 'none' — поведение отчёта не меняется.
 */
export function buildDealFilterWhere(filters: DealFilter[] | undefined | null): { sql: string; key: string } {
  if (!Array.isArray(filters) || filters.length === 0) return { sql: '', key: 'none' };
  const parts = filters.slice(0, MAX_FILTERS).map(clauseFor).filter(Boolean);
  if (parts.length === 0) return { sql: '', key: 'none' };
  return {
    sql: parts.join(' AND '),
    // Ключ — сам SQL: два разных фильтра не могут дать одинаковый фрагмент, а
    // одинаковые фильтры, записанные в разном порядке полей, дадут разные ключи
    // (лишний промах кэша, но не протечку данных — это правильная сторона).
    key: parts.join(' AND '),
  };
}

/** Валидация формы запроса (роут). Возвращает текст ошибки или null. */
export function validateDealFilters(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) return 'dealFilters должен быть массивом';
  if (input.length > MAX_FILTERS) return `dealFilters: максимум ${MAX_FILTERS} условий`;
  for (const f of input as DealFilter[]) {
    if (!f || typeof f !== 'object') return 'dealFilters: условие должно быть объектом';
    if (!DEAL_FILTER_FIELDS[f.field]) return `dealFilters: неизвестное поле «${f.field}»`;
    if (!opsForField(f.field).includes(f.op)) return `dealFilters: оператор «${f.op}» недопустим для поля «${f.field}»`;
    if (Array.isArray(f.value) && f.value.length > MAX_LIST) return `dealFilters: максимум ${MAX_LIST} значений в списке`;
    // Значение обязано разбираться в литерал. Без этой проверки «сумма ≥ абв»
    // проходила валидацию, clauseFor молча отдавал пустое условие — и отчёт
    // строился ПО ВСЕМ сделкам, пока плашка над таблицей уверяла, что фильтр
    // применён. Молча непримененный фильтр опаснее ошибки: человек делает вывод
    // по цифрам, которые считают не то, что он думает.
    if (f.op !== 'is_null' && f.op !== 'is_not_null' && clauseFor(f) === '') {
      const def = DEAL_FILTER_FIELDS[f.field];
      const hint = def.kind === 'number' || def.kind === 'int' ? 'нужно число'
        : def.kind === 'date' ? 'нужна дата в формате ГГГГ-ММ-ДД'
        : 'значение пустое или слишком длинное';
      return `dealFilters: «${def.label}» — ${hint}`;
    }
  }
  return null;
}

/** Человеческое описание фильтра — для плашки над таблицей и подписи в отчёте. */
export function describeDealFilters(filters: DealFilter[] | undefined | null): string[] {
  if (!Array.isArray(filters)) return [];
  const OP_LABEL: Record<string, string> = {
    eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
    in: 'из', not_in: 'кроме', between: 'от', is_null: 'не заполнено', is_not_null: 'заполнено',
  };
  return filters.flatMap(f => {
    const def = DEAL_FILTER_FIELDS[f.field];
    if (!def) return [];
    if (f.op === 'is_null' || f.op === 'is_not_null') return [`${def.label}: ${OP_LABEL[f.op]}`];
    if (f.op === 'between' && Array.isArray(f.value)) return [`${def.label}: от ${f.value[0]} до ${f.value[1]}`];
    const v = Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '');
    return [`${def.label} ${OP_LABEL[f.op] ?? f.op} ${v}`];
  });
}

/** Справочники значений для пикера (см. app/api/reports/deal-filter-options). */
export async function dealFilterOptions(client: PoolClient): Promise<Record<string, { value: string; label: string }[]>> {
  const [funnels, stages, heads, sources] = await Promise.all([
    client.query<{ id: number; name: string }>(`SELECT id, name FROM funnels ORDER BY name`),
    client.query<{ id: string; name: string }>(`SELECT id, name FROM stages ORDER BY name`),
    client.query<{ v: string }>(`SELECT DISTINCT head_group_name v FROM sa.deals WHERE head_group_name IS NOT NULL ORDER BY 1`),
    client.query<{ v: string }>(`SELECT DISTINCT source_id v FROM sa.deals WHERE source_id IS NOT NULL ORDER BY 1`),
  ]);
  return {
    funnels: funnels.rows.map(r => ({ value: String(r.id), label: r.name })),
    stages: stages.rows.map(r => ({ value: r.id, label: r.name })),
    head_groups: heads.rows.map(r => ({ value: r.v, label: r.v })),
    sources: sources.rows.map(r => ({ value: r.v, label: r.v })),
  };
}
