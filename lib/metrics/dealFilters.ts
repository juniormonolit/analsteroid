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
  | 'contains' | 'not_contains'
  | 'is_null' | 'is_not_null';

export interface DealFilter {
  field: string;
  op: DealFilterOp;
  /** Для between — [от, до]; для in/not_in — массив; иначе скаляр. */
  value?: string | number | (string | number)[] | null;
}

type FieldKind = 'number' | 'date' | 'text' | 'int' | 'bool';

interface FieldDef {
  /** Колонка в sa.deals. */
  column: string;
  kind: FieldKind;
  label: string;
  /** Справочник значений для пикера (см. dealFilterOptions ниже; client_kind и
   *  stage_entered_presets — статические, отдаются роутом без запроса в БД). */
  options?: 'funnels' | 'stages' | 'head_groups' | 'sources' | 'client_kind' | 'stage_entered_presets'
    | 'product_groups' | 'bool' | 'product_search';
  /** Псевдополе: своё SQL-выражение вместо d.<column> (тип клиента = воронка).
   *  ctx нужен полям, которые зависят от ДРУГОГО условия того же фильтра —
   *  «Сумма по товару» без «Товара» не имеет смысла (см. FilterCtx). */
  customSql?: (op: DealFilterOp, values: string[], ctx: FilterCtx) => string;
  /** Операторы поля, если их нельзя вывести из kind/customSql. */
  ops?: DealFilterOp[];
}

/** Контекст набора фильтров: условия, которые смотрят друг на друга. */
export interface FilterCtx {
  /** SQL-литерал '%роклайт%' из условия «Товар», если оно есть в наборе. */
  productLike: string | null;
}

const NUM_OPS: DealFilterOp[] = ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq', 'is_null', 'is_not_null'];
const SET_OPS: DealFilterOp[] = ['in', 'not_in', 'eq', 'neq', 'is_null', 'is_not_null'];
// Свободный текст без справочника: «содержит» — главный оператор, с него и
// начинаем (искать сделку по куску названия нужнее, чем по точному совпадению).
const TEXT_OPS: DealFilterOp[] = ['contains', 'not_contains', 'eq', 'neq', 'is_null', 'is_not_null'];
const DATE_OPS: DealFilterOp[] = ['gte', 'lte', 'between', 'is_null', 'is_not_null'];
const BOOL_OPS: DealFilterOp[] = ['eq', 'neq'];

// ЮЛ/ФЛ определяются номером воронки — ровно так же, как funnel_type b2b/b2c в
// sqlGen.ts::resolveFilterClause. Держим ту же карту, а не заводим вторую правду.
const B2C_FUNNELS = [0, 2];
const B2B_FUNNELS = [1, 3];

// ── Позиции сделки (sa.deals.products) ───────────────────────────────────────
// products — jsonb-массив строк вида {name, product_id, quantity, price, sum,
// head_group_id, head_group_name, type}. Живая проверка 01.10.2026: 259 518
// сделок, у 218 538 массив непустой, 470 214 позиций, 60 056 разных названий и
// 37 379 product_id. quantity и sum — ВСЕГДА jsonb-число (проверено по всем
// 470 тыс. строк), поэтому ::numeric безопасен без защиты от текста.
//
// ПОЧЕМУ ПОИСК ПО ПОДСТРОКЕ, А НЕ ВЫБОР ИЗ СПРАВОЧНИКА: один товар живёт в
// данных под десятками названий. «Роклайт» — это 25 разных строк и 12 разных
// product_id («Утеплитель Технониколь Роклайт 50 % компрессия 100 х 600 х 1200
// мм», та же строка с хвостом «| 17 куб 1,26 тон», «Технониколь Роклайт
// 1200*600*50», у части позиций product_id вообще NULL). Выбор одного значения
// из списка поймал бы меньшую часть сделок и соврал бы молча.
//
// ОГРАНИЧЕНИЕ ПО СКОРОСТИ: индекса под ILIKE внутри jsonb нет, условие даёт
// Seq Scan по sa.deals (замер 01.10: 1,3 с на полном проходе 259 тыс. строк).
// В отчёте условие идёт в AND с периодом и скоупом, поэтому на практике
// разбирается уже урезанный набор. Если станет узким местом — лечится
// trigram-индексом по products::text, но это чужая схема (БД Миши), трогать её
// в одностороннем порядке не стали.
const PRODUCT_ARR = `CASE WHEN jsonb_typeof(d.products) = 'array' THEN d.products ELSE '[]'::jsonb END`;

/** Литерал '%текст%' для ILIKE: кавычки удваиваются, %/_/\\ экранируются,
 *  иначе «скидка 50%» ловила бы всё подряд. */
function sqlLike(v: unknown): string | null {
  const raw = String(v ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_STR) return null;
  const esc = raw.replace(/[\\%_]/g, m => '\\' + m).replace(/'/g, "''");
  return `'%${esc}%'`;
}

/** Сумма/количество ПО СТРОКАМ, попавшим под условие «Товар». */
function productAgg(field: 'sum' | 'quantity', like: string): string {
  return `(SELECT COALESCE(SUM((pl->>'${field}')::numeric), 0)
      FROM jsonb_array_elements(${PRODUCT_ARR}) pl WHERE pl->>'name' ILIKE ${like})`;
}

// У агрегата по позициям «не заполнено» не бывает: нет строк — сумма 0.
const NUM_OPS_NO_NULL: DealFilterOp[] = ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq'];

/** «Сумма/количество по товару» <оператор> <значение>. */
function cmpAgg(field: 'sum' | 'quantity', op: DealFilterOp, values: string[], like: string): string {
  const agg = productAgg(field, like);
  if (op === 'between') {
    const a = sqlNumber(values[0]); const b = sqlNumber(values[1]);
    return a === null || b === null ? '' : `${agg} BETWEEN ${a} AND ${b}`;
  }
  const n = sqlNumber(values[0]);
  const sym = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op as 'eq'];
  return n === null || !sym ? '' : `${agg} ${sym} ${n}`;
}

export const DEAL_FILTER_FIELDS: Record<string, FieldDef> = {
  amount:          { column: 'amount',          kind: 'number', label: 'Сумма сделки, ₽' },
  head_group_name: { column: 'head_group_name', kind: 'text',   label: 'Товарная группа', options: 'head_groups' },
  funnel_id:       { column: 'funnel_id',       kind: 'int',    label: 'Воронка',         options: 'funnels' },
  stage_id:        { column: 'stage_id',        kind: 'text',   label: 'Стадия',          options: 'stages' },
  source_id:       { column: 'source_id',       kind: 'text',   label: 'Источник',        options: 'sources' },
  created_at:      { column: 'created_at',      kind: 'date',   label: 'Дата создания сделки' },
  // «В текущей стадии с …» (идея владельца 31.08, запрос ОП: «видеть сделки,
  // которые попали в этот статус сегодня»). Дата входа в ТЕКУЩУЮ стадию сделки
  // считается из истории событий (последнее событие сделки с её нынешней
  // стадией) — отдельной колонки в sa.deals нет. Комбинируется с чем угодно:
  // «Стадии (сейчас)» + «сегодня» = свежий остаток статуса; «дольше 7 дней» =
  // зависшие. История deal_events ведётся с 03.04.2026: у сделки, не менявшей
  // стадию с тех пор, даты нет (NULL) — такие считаются «давно в стадии» и
  // попадают только под пресеты «дольше N дней».
  stage_entered_at: {
    column: 'stage_id', kind: 'text', label: 'В текущей стадии с', options: 'stage_entered_presets',
    customSql: (_op, values) => {
      const preset = values[0] ?? '';
      // Последний вход сделки в её текущую стадию; полночь сегодня в МСК.
      const entered = `(SELECT MAX(e.event_at) FROM deal_events e WHERE e.deal_id = d.deal_id AND e.stage_id = d.stage_id)`;
      const msk0 = `(date_trunc('day', (now() AT TIME ZONE 'Europe/Moscow'))::timestamp AT TIME ZONE 'Europe/Moscow')`;
      if (preset === 'today') return `${entered} >= ${msk0}`;
      if (preset === 'yesterday') return `(${entered} >= ${msk0} - interval '1 day' AND ${entered} < ${msk0})`;
      const last = /^last(\d{1,3})$/.exec(preset);
      // «Последние N дней» — календарных, включая сегодня.
      if (last) return `${entered} >= ${msk0} - interval '${Number(last[1]) - 1} days'`;
      const over = /^over(\d{1,3})$/.exec(preset);
      // «Дольше N дней» — дополнение к lastN; NULL (вход до старта истории
      // 03.04.2026) — тоже «давно», включаем.
      if (over) return `(${entered} < ${msk0} - interval '${Number(over[1]) - 1} days' OR ${entered} IS NULL)`;
      return '';
    },
  },
  client_kind:     {
    column: 'funnel_id', kind: 'text', label: 'Тип клиента (ЮЛ/ФЛ)', options: 'client_kind',
    customSql: (op, values) => {
      const ids = values.flatMap(v => v === 'b2b' ? B2B_FUNNELS : v === 'b2c' ? B2C_FUNNELS : []);
      if (ids.length === 0) return '';
      const list = ids.join(', ');
      return op === 'neq' || op === 'not_in'
        ? `d.funnel_id NOT IN (${list})`
        : `d.funnel_id IN (${list})`;
    },
  },
  // ── Товар в позициях сделки (задача владельца 01.10.2026) ──────────────────
  // «Хочу сделки в работе с чеком больше 300 тысяч на роклайт». Три поля:
  // «Товар» задаёт, ЧТО ищем, «Сумма/Количество по товару» — сколько ЭТОГО
  // товара в сделке. Разделять их на независимые условия было нельзя: два
  // независимых фильтра «есть роклайт» И «есть позиция дороже 300 тыс.»
  // поймали бы сделку, где роклайта на 5 тысяч, а на 300 тысяч — бетон.
  // Поэтому сумма и количество считаются ТОЛЬКО по строкам, попавшим под
  // условие «Товар», и без него не имеют смысла (валидация ниже это требует).
  product_name: {
    column: 'products', kind: 'text', label: 'Товар (в позициях сделки)',
    options: 'product_search', ops: ['contains', 'not_contains'],
    customSql: (op, values) => {
      const like = sqlLike(values[0]);
      if (!like) return '';
      const has = `EXISTS (SELECT 1 FROM jsonb_array_elements(${PRODUCT_ARR}) pl WHERE pl->>'name' ILIKE ${like})`;
      return op === 'not_contains' ? `NOT ${has}` : has;
    },
  },
  product_sum: {
    column: 'products', kind: 'number', label: 'Сумма по товару, ₽', ops: NUM_OPS_NO_NULL,
    customSql: (op, values, ctx) => ctx.productLike ? cmpAgg('sum', op, values, ctx.productLike) : '',
  },
  product_qty: {
    column: 'products', kind: 'number', label: 'Количество по товару', ops: NUM_OPS_NO_NULL,
    customSql: (op, values, ctx) => ctx.productLike ? cmpAgg('quantity', op, values, ctx.productLike) : '',
  },

  // ── Остальные колонки sa.deals (задача владельца 01.10.2026: «фильтровать по
  // любому полю из deals») ───────────────────────────────────────────────────
  // Список намеренно РУЧНОЙ, а не из information_schema: белый список — это
  // граница безопасности (см. блок «Про безопасность» выше), и подпись на
  // русском полезнее сырого имени колонки. Не вошли сюда products и activities:
  // это jsonb-массивы, сравнивать их целиком бессмысленно — у products для
  // этого есть три поля выше, у activities фильтры живут в метриках «Дела».
  deal_id:            { column: 'deal_id',            kind: 'int',  label: 'ID сделки',          ops: NUM_OPS },
  deal_name:          { column: 'deal_name',          kind: 'text', label: 'Название сделки',    ops: TEXT_OPS },
  deal_type:          { column: 'deal_type',          kind: 'text', label: 'Тип сделки',         ops: TEXT_OPS },
  is_reserved:        { column: 'is_reserved',        kind: 'bool', label: 'Бронь',              options: 'bool' },
  head_group_id:      { column: 'head_group_id',      kind: 'int',  label: 'ID товарной группы (by_max)', ops: NUM_OPS },
  product_group_id:   { column: 'product_group_id',   kind: 'int',  label: 'Товарная группа (kc)', options: 'product_groups' },
  current_manager_id: { column: 'current_manager_id', kind: 'int',  label: 'ID менеджера (Битрикс)', ops: NUM_OPS },
  team_id:            { column: 'team_id',            kind: 'int',  label: 'ID команды',         ops: NUM_OPS },
  lead_id:            { column: 'lead_id',            kind: 'int',  label: 'ID лида',            ops: NUM_OPS },
  contact_id:         { column: 'contact_id',         kind: 'int',  label: 'ID контакта',        ops: NUM_OPS },
  company_id:         { column: 'company_id',         kind: 'int',  label: 'ID компании',        ops: NUM_OPS },
  manager_history:    { column: 'manager_history',    kind: 'text', label: 'История менеджеров', ops: TEXT_OPS },

  // Даты. is_null/is_not_null здесь — рабочий инструмент, а не формальность:
  // «Дата продажи не заполнена» = сделка ещё не продана.
  updated_at:     { column: 'updated_at',     kind: 'date', label: 'Дата изменения' },
  reserved_at:    { column: 'reserved_at',    kind: 'date', label: 'Дата брони' },
  confirmed_at:   { column: 'confirmed_at',   kind: 'date', label: 'Дата подтверждения' },
  sold_at:        { column: 'sold_at',        kind: 'date', label: 'Дата продажи' },
  delivered_at:   { column: 'delivered_at',   kind: 'date', label: 'Дата отгрузки' },
  lost_at:        { column: 'lost_at',        kind: 'date', label: 'Дата потери' },
  last_event_at:  { column: 'last_event_at',  kind: 'date', label: 'Дата последнего события' },
  mlt_date_sale:  { column: 'mlt_date_sale',  kind: 'date', label: 'Дата продажи (МЛТ)' },
};

export function opsForField(field: string): DealFilterOp[] {
  const def = DEAL_FILTER_FIELDS[field];
  if (!def) return [];
  if (def.ops) return def.ops;                     // поле объявило операторы само
  if (field === 'stage_entered_at') return ['eq']; // пресеты периодов, «не равно» не имеет смысла
  if (def.customSql) return ['eq', 'neq'];
  if (def.kind === 'bool') return BOOL_OPS;
  if (def.kind === 'number' || def.kind === 'int') return def.options ? SET_OPS : NUM_OPS;
  if (def.kind === 'date') return DATE_OPS;
  // Текст со справочником — выбор из списка; свободный текст — «содержит».
  return def.options ? SET_OPS : TEXT_OPS;
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
  if (kind === 'bool') {
    const s = String(v ?? '').trim().toLowerCase();
    return s === 'true' ? 'TRUE' : s === 'false' ? 'FALSE' : null;
  }
  return sqlText(v);
}

const EMPTY_CTX: FilterCtx = { productLike: null };

/** Контекст набора: достаём условие «Товар», от которого зависят «Сумма/
 *  Количество по товару». Берём ПЕРВОЕ условие «содержит» — именно оно
 *  задаёт строки, по которым считается агрегат. */
function ctxOf(filters: DealFilter[]): FilterCtx {
  const pf = filters.find(f => f.field === 'product_name' && f.op === 'contains');
  const v = pf ? (Array.isArray(pf.value) ? pf.value[0] : pf.value) : null;
  return { productLike: v != null ? sqlLike(v) : null };
}

/** Один фильтр → SQL-условие. Невалидный фильтр даёт '' и молча пропускается —
 *  так же ведёт себя resolveFilterClause: наполовину применённый фильтр опаснее
 *  непримененного, а форму условий валидирует UI и роут до этого места. */
function clauseFor(f: DealFilter, ctx: FilterCtx = EMPTY_CTX): string {
  const def = DEAL_FILTER_FIELDS[f.field];
  if (!def) return '';
  if (!opsForField(f.field).includes(f.op)) return '';
  const col = `d.${def.column}`;

  if (def.customSql) {
    const vals = (Array.isArray(f.value) ? f.value : [f.value]).map(v => String(v ?? ''));
    return def.customSql(f.op, vals.slice(0, MAX_LIST), ctx);
  }
  if (f.op === 'is_null') return `${col} IS NULL`;
  if (f.op === 'is_not_null') return `${col} IS NOT NULL`;

  // «Содержит» — ILIKE по подстроке. Только для текста: на числе и дате
  // Postgres молча привёл бы колонку к тексту и сравнивал '2026-10-01' как
  // строку, а человек ждал бы сравнения дат.
  if (f.op === 'contains' || f.op === 'not_contains') {
    if (def.kind !== 'text') return '';
    const like = sqlLike(Array.isArray(f.value) ? f.value[0] : f.value);
    if (like === null) return '';
    return f.op === 'contains' ? `${col} ILIKE ${like}` : `(${col} IS NULL OR ${col} NOT ILIKE ${like})`;
  }

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
  const list = filters.slice(0, MAX_FILTERS);
  const ctx = ctxOf(list);
  const parts = list.map(f => clauseFor(f, ctx)).filter(Boolean);
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
  const all = input as DealFilter[];
  const ctx = ctxOf(all);
  // «Сумма/Количество по товару» без условия «Товар ... содержит» посчиталось бы
  // по пустому множеству строк (всегда 0) и молча выкинуло бы все сделки.
  // Лучше внятная ошибка, чем пустой отчёт с плашкой «фильтр применён».
  if (!ctx.productLike && all.some(f => f?.field === 'product_sum' || f?.field === 'product_qty')) {
    return 'dealFilters: «Сумма по товару» и «Количество по товару» работают только вместе с условием «Товар … содержит» — иначе непонятно, по какому товару считать';
  }
  for (const f of all) {
    if (!f || typeof f !== 'object') return 'dealFilters: условие должно быть объектом';
    if (!DEAL_FILTER_FIELDS[f.field]) return `dealFilters: неизвестное поле «${f.field}»`;
    if (!opsForField(f.field).includes(f.op)) return `dealFilters: оператор «${f.op}» недопустим для поля «${f.field}»`;
    if (Array.isArray(f.value) && f.value.length > MAX_LIST) return `dealFilters: максимум ${MAX_LIST} значений в списке`;
    // Значение обязано разбираться в литерал. Без этой проверки «сумма ≥ абв»
    // проходила валидацию, clauseFor молча отдавал пустое условие — и отчёт
    // строился ПО ВСЕМ сделкам, пока плашка над таблицей уверяла, что фильтр
    // применён. Молча непримененный фильтр опаснее ошибки: человек делает вывод
    // по цифрам, которые считают не то, что он думает.
    if (f.op !== 'is_null' && f.op !== 'is_not_null' && clauseFor(f, ctx) === '') {
      const def = DEAL_FILTER_FIELDS[f.field];
      const hint = def.kind === 'number' || def.kind === 'int' ? 'нужно число'
        : def.kind === 'date' ? 'нужна дата в формате ГГГГ-ММ-ДД'
        : def.kind === 'bool' ? 'нужно «да» или «нет»'
        : 'значение пустое или слишком длинное';
      return `dealFilters: «${def.label}» — ${hint}`;
    }
  }
  return null;
}

/** Пресеты «В текущей стадии с» — для пикера и человеческих подписей. */
export const STAGE_ENTERED_PRESETS: { value: string; label: string }[] = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: 'last7', label: 'Последние 7 дней' },
  { value: 'last30', label: 'Последние 30 дней' },
  { value: 'over7', label: 'Дольше 7 дней' },
  { value: 'over30', label: 'Дольше 30 дней' },
];

/** Человеческое описание фильтра — для плашки над таблицей и подписи в отчёте. */
export function describeDealFilters(filters: DealFilter[] | undefined | null): string[] {
  if (!Array.isArray(filters)) return [];
  const OP_LABEL: Record<string, string> = {
    eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
    in: 'из', not_in: 'кроме', between: 'от', is_null: 'не заполнено', is_not_null: 'заполнено',
    contains: 'содержит', not_contains: 'не содержит',
  };
  return filters.flatMap(f => {
    const def = DEAL_FILTER_FIELDS[f.field];
    if (!def) return [];
    if (f.field === 'stage_entered_at') {
      const p = STAGE_ENTERED_PRESETS.find(x => x.value === String(f.value ?? ''));
      return [`${def.label}: ${(p?.label ?? String(f.value ?? '')).toLowerCase()}`];
    }
    if (f.op === 'is_null' || f.op === 'is_not_null') return [`${def.label}: ${OP_LABEL[f.op]}`];
    // Булево показываем словом: «Бронь = true» в плашке над таблицей читается
    // как технический мусор.
    if (def.kind === 'bool') {
      const yes = String(Array.isArray(f.value) ? f.value[0] : f.value) === 'true';
      return [`${def.label}: ${(f.op === 'neq') !== yes ? 'да' : 'нет'}`];
    }
    if (f.op === 'between' && Array.isArray(f.value)) return [`${def.label}: от ${f.value[0]} до ${f.value[1]}`];
    const v = Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '');
    return [`${def.label} ${OP_LABEL[f.op] ?? f.op} ${v}`];
  });
}

/** Справочники значений для пикера (см. app/api/reports/deal-filter-options). */
export async function dealFilterOptions(client: PoolClient): Promise<Record<string, { value: string; label: string }[]>> {
  const [funnels, stages, heads, sources, pgroups] = await Promise.all([
    client.query<{ id: number; name: string }>(`SELECT id, name FROM funnels ORDER BY name`),
    client.query<{ id: string; name: string }>(`SELECT id, name FROM stages ORDER BY name`),
    client.query<{ v: string }>(`SELECT DISTINCT head_group_name v FROM sa.deals WHERE head_group_name IS NOT NULL ORDER BY 1`),
    client.query<{ v: string }>(`SELECT DISTINCT source_id v FROM sa.deals WHERE source_id IS NOT NULL ORDER BY 1`),
    client.query<{ id: number; name: string }>(`SELECT id, name FROM sa.product_groups WHERE is_active = true ORDER BY name`),
  ]);
  return {
    funnels: funnels.rows.map(r => ({ value: String(r.id), label: r.name })),
    stages: stages.rows.map(r => ({ value: r.id, label: r.name })),
    head_groups: heads.rows.map(r => ({ value: r.v, label: r.v })),
    sources: sources.rows.map(r => ({ value: r.v, label: r.v })),
    product_groups: pgroups.rows.map(r => ({ value: String(r.id), label: r.name })),
    bool: [{ value: 'true', label: 'Да' }, { value: 'false', label: 'Нет' }],
  };
}
