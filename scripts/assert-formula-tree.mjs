// Assert-скрипт дерева формул «Разбора метрики» (lib/metrics/formulaTree.ts) и
// чипов выборки (lib/metrics/formulaText.ts).
//
// Зачем отдельный прогон: парсер заменяет собой Function()-вычисление в
// evalFormula (features/reports/engine/calculated.ts), и его null-семантика
// обязана совпадать с ней байт-в-байт — иначе «Разбор» покажет число там, где
// таблица отчёта ставит прочерк. Здесь же — что metricFormulaLine не изменилась
// после выноса общих кусков в хелперы.
//
// Запуск: node scripts/assert-formula-tree.mjs
// (Node ≥ 22.6: .ts импортируется через встроенный type-stripping; резолвер
// расширений регистрируем сами, чтобы не зависеть от флага --import.)
import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);

const {
  parseFormula, evalFormulaTree, formulaRefs, formatOp, needsParens,
} = await import('../lib/metrics/formulaTree.ts');
const {
  metricFormulaLine, collectedSelectionChips, metricValueKind,
} = await import('../lib/metrics/formulaText.ts');

let failures = 0;
let passed = 0;

function check(cond, label) {
  if (cond) { passed++; return; }
  failures++;
  console.error(`FAIL ${label}`);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures++;
  console.error(`FAIL ${label}\n    ожидалось: ${e}\n    получено:  ${a}`);
}

/** Печать дерева обратно в строку — через needsParens, как будет делать UI. */
function print(node) {
  if (node.kind === 'num') return String(node.value);
  if (node.kind === 'ref') return `[${node.id}]`;
  const side = (child, s) => {
    const txt = print(child);
    return needsParens(node, child, s) ? `(${txt})` : txt;
  };
  return `${side(node.left, 'left')} ${formatOp(node.op)} ${side(node.right, 'right')}`;
}

function evalStr(formula, values) {
  const tree = parseFormula(formula);
  return tree ? evalFormulaTree(tree, values) : undefined;
}

// ── разбор и вычисление ─────────────────────────────────────────────────────
eq(evalStr('[a] / [b] * 100', { a: 10, b: 4 }), 250, '[a] / [b] * 100 → 250');
eq(evalStr('([a] + [b]) / [c]', { a: 1, b: 5, c: 3 }), 2, '([a] + [b]) / [c] → 2');
eq(evalStr('[a] + [b] - 1', { a: 1, b: 5 }), 5, '[a] + [b] - 1 → 5');
eq(evalStr('(([a] + [b]) * ([c] - 1)) / 2', { a: 1, b: 2, c: 5 }), 6, 'вложенные скобки → 6');
eq(evalStr('-[a] + 10', { a: 3 }), 7, 'унарный минус перед ссылкой → 7');
eq(evalStr('[a] * -2', { a: 3 }), -6, 'унарный минус перед числом → −6');
eq(evalStr('-(-[a])', { a: 3 }), 3, 'двойной унарный минус → 3');
eq(evalStr('[a] - [b] - [c]', { a: 10, b: 3, c: 2 }), 5, 'левая ассоциативность минуса → 5');
eq(evalStr('[a] / [b] / [c]', { a: 12, b: 3, c: 2 }), 2, 'левая ассоциативность деления → 2');
eq(evalStr('[a] + [b] * 2', { a: 1, b: 2 }), 5, 'приоритет умножения → 5');
eq(evalStr('1.5 * [a]', { a: 2 }), 3, 'десятичное число → 3');

// ── null-семантика как в evalFormula ────────────────────────────────────────
eq(evalStr('[a] / [b]', { a: 10, b: 0 }), null, 'деление на ноль → null');
eq(evalStr('[a] / [b]', { a: 0, b: 0 }), null, '0 / 0 → null');
eq(evalStr('[a] + [b]', { a: 10, b: null }), null, 'null-протяжка: null-операнд → null');
eq(evalStr('[a] + [b]', { a: 10 }), null, 'null-протяжка: неизвестная ссылка → null');
eq(evalStr('[a] * 0', { a: null }), null, 'null × 0 → null (не 0, как и в evalFormula)');
eq(evalStr('[a] + 1', { a: Number.NaN }), null, 'NaN во входе → null');
eq(evalStr('[a] + 1', { a: Number.POSITIVE_INFINITY }), null, '±Infinity во входе → null');

// ── легаси: голый идентификатор ─────────────────────────────────────────────
eq(evalStr('deals_amount / deals_count', { deals_amount: 100, deals_count: 4 }), 25, 'голые идентификаторы → 25');
{
  const t = parseFormula('x-1');
  eq(t && formulaRefs(t), ['x'], 'дефис после голого id — вычитание, не часть имени');
  eq(t && evalFormulaTree(t, { x: 5 }), 4, 'x-1 при x=5 → 4');
}
{
  const t = parseFormula('[with-dash] + 1');
  eq(t && formulaRefs(t), ['with-dash'], 'дефис внутри скобок — часть id');
}

// ── мусор → null ────────────────────────────────────────────────────────────
for (const junk of ['', '   ', '[a] +', '/ [a]', '([a] + [b]', '[a] + [b])', '[a] [b]', '[a] ** 2',
  '[a] % 2', '[]', '[a b] + 1', '1.', '.5', '[a] = [b]', 'a ++ b', ')(']) {
  eq(parseFormula(junk), null, `мусор ${JSON.stringify(junk)} → null`);
}

// ── formulaRefs: уникальные, в порядке появления ────────────────────────────
{
  const t = parseFormula('([b] + [a]) / ([b] + [c]) * [a]');
  eq(t && formulaRefs(t), ['b', 'a', 'c'], 'formulaRefs без дублей, порядок появления');
  eq(formulaRefs({ kind: 'num', value: 1 }), [], 'formulaRefs числа — пусто');
}

// ── formatOp ────────────────────────────────────────────────────────────────
eq([formatOp('+'), formatOp('-'), formatOp('*'), formatOp('/')], ['+', '−', '×', '÷'], 'formatOp');

// ── needsParens и печать ────────────────────────────────────────────────────
{
  const t = parseFormula('([a] - [b]) * [c]');
  check(t && t.kind === 'op' && needsParens(t, t.left, 'left') === true, 'needsParens: ([a] − [b]) слева от ×');
  check(t && t.kind === 'op' && needsParens(t, t.right, 'right') === false, 'needsParens: [c] справа от × — без скобок');
  eq(t && print(t), '([a] − [b]) × [c]', 'печать ([a] - [b]) * [c]');
}
{
  const t = parseFormula('[a] - ([b] - [c])');
  check(t && t.kind === 'op' && needsParens(t, t.right, 'right') === true, 'needsParens: правый минус под минусом');
  eq(t && print(t), '[a] − ([b] − [c])', 'печать [a] - ([b] - [c])');
}
{
  const t = parseFormula('([a] - [b]) - [c]');
  check(t && t.kind === 'op' && needsParens(t, t.left, 'left') === false, 'needsParens: левый минус под минусом — без скобок');
  eq(t && print(t), '[a] − [b] − [c]', 'печать ([a] - [b]) - [c] без лишних скобок');
}
{
  const t = parseFormula('[a] / [b] * 100');
  eq(t && print(t), '[a] ÷ [b] × 100', 'печать [a] / [b] * 100 без скобок');
}
{
  const t = parseFormula('[a] * ([b] / [c])');
  eq(t && print(t), '[a] × ([b] ÷ [c])', 'печать: правое деление под умножением — скобки сохраняются');
}
{
  const t = parseFormula('[a] + ([b] + [c])');
  eq(t && print(t), '[a] + [b] + [c]', 'печать: правый плюс под плюсом — скобки не нужны');
}
{
  const t = parseFormula('[a] + [b] * [c]');
  eq(t && print(t), '[a] + [b] × [c]', 'печать: умножение под плюсом — без скобок');
}
// Печать → повторный разбор даёт то же дерево (needsParens не теряет структуру).
for (const src of ['([a] - [b]) * [c]', '[a] - ([b] - [c])', '[a] * ([b] / [c])', '[a] + ([b] - [c])',
  '(([a] + [b]) * ([c] - 1)) / 2', '-[a] + 10']) {
  const t = parseFormula(src);
  const again = t && parseFormula(print(t).replaceAll('−', '-').replaceAll('×', '*').replaceAll('÷', '/'));
  eq(again, t, `round-trip печати: ${src}`);
}

// ── formulaText: чипы выборки и вид значения ─────────────────────────────────
const baseMetric = {
  id: 'm', nameRu: 'M', nameShortRu: null, calcOk: true, fillOk: true,
  metricType: 'collected', dataType: 'int', formula: null, dependencies: [], decimalPlaces: 0,
  aggregationFn: 'sum', category: null, sortOrder: 0, isCore: false, isActive: true,
  isHiddenInUi: false, isTest: false, source: 'deals', aggFn: 'count_distinct', aggField: 'deal_id',
  dateField: 'sold_at', filters: [], tags: [], isCollectOk: true, isCalcOk: true,
};
{
  const m = {
    ...baseMetric,
    filters: [
      { field: 'funnel_type', op: 'eq', value: 'primary' },
      { field: '_has_call', op: 'eq', value: true },
      { field: 'lost_at', op: 'gt_field', value: 'sold_at' },
    ],
  };
  eq(collectedSelectionChips(m), [
    'число сделок (каждая — один раз)',
    'дата продажи попадает в период',
    'воронка — первичные',
    'по сделке есть хотя бы один звонок',
    'дата отказа позже, чем дата продажи',
  ], 'collectedSelectionChips: агрегат, окно, фильтры');
  // Строка «формула» не изменилась после выноса хелперов — эталон снят с прежнего кода.
  eq(metricFormulaLine(m),
    '= число сделок (каждая — один раз), у которых дата продажи попадает в период; условия: воронка — первичные; по сделке есть хотя бы один звонок; дата отказа позже, чем дата продажи',
    'metricFormulaLine байт-в-байт (с окном и фильтрами)');
}
{
  const m = { ...baseMetric, aggFn: 'sum', aggField: 'amount', dateField: null, dataType: 'money' };
  eq(collectedSelectionChips(m), ['сумма сделок, ₽'], 'collectedSelectionChips: без окна и фильтров');
  eq(metricFormulaLine(m), '= сумма сделок, ₽', 'metricFormulaLine байт-в-байт (без окна)');
  eq(metricValueKind(m), 'amount', 'metricValueKind: sum:amount → amount');
}
{
  const m = { ...baseMetric, aggFn: 'avg', aggField: 'discount', dateField: 'created_at' };
  eq(collectedSelectionChips(m), ['среднее по полю discount', 'дата создания попадает в период'], 'chips: generic-агрегат');
  eq(metricFormulaLine(m), '= среднее по полю discount, у которых дата создания попадает в период', 'metricFormulaLine байт-в-байт (generic)');
  eq(metricValueKind(m), 'other', 'metricValueKind: avg по не-amount → other');
}
eq(metricValueKind(baseMetric), 'count', 'metricValueKind: count_distinct → count');
eq(metricValueKind({ ...baseMetric, aggFn: 'count_all', aggField: null }), 'count', 'metricValueKind: count_all → count');
eq(metricValueKind({ ...baseMetric, metricType: 'calculated', dataType: 'percent', formula: '[a] / [b] * 100' }), 'other', 'calculated percent → other');
eq(metricValueKind({ ...baseMetric, metricType: 'calculated', dataType: 'money', formula: '[a] / [b]' }), 'amount', 'calculated money → amount');
eq(metricValueKind({ ...baseMetric, metricType: 'external', dataType: 'int', aggFn: null }), 'count', 'external int → count');
eq(collectedSelectionChips({ ...baseMetric, metricType: 'calculated', formula: '[a] / [b]' }), [], 'chips calculated → []');
eq(collectedSelectionChips({ ...baseMetric, metricType: 'external' }), [], 'chips external → []');
// Ручная formula_human имеет приоритет — как и раньше.
eq(metricFormulaLine({ ...baseMetric, formulaHuman: 'ручная' }), 'ручная', 'metricFormulaLine: formulaHuman приоритетнее');

// ── все формулы каталога из миграций разбираются ────────────────────────────
for (const f of [
  '([calls_completed_duration_sum] + [calls_completed_duration_sum_repeat] + [calls_completed_duration_sum_orphan]) / ([calls_completed_count] + [calls_completed_count_repeat] + [calls_completed_count_orphan])',
  '([primary_sales_amount] + [repeat_sales_amount]) / [plan_sales_current_day] * 100',
  '[cohort_repeat_clients] / [cohort_clients] * 100',
  '[manager_primary_deals_activity] / [manager_worked_days_count]',
]) {
  check(parseFormula(f) !== null, `формула каталога разбирается: ${f.slice(0, 60)}…`);
}

console.log(`assert-formula-tree: ${passed} ок, ${failures} провалов`);
if (failures > 0) process.exit(1);
