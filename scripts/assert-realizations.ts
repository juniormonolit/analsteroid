/**
 * Assert-скрипт раздела «Продажи → Реализация» (задача #8034), без БД.
 *  1. canViewRealizations — только «Администратор» и супер-админ; роль с
 *     явным section.realization / джокером section.* без роли — НЕ проходит.
 *  2. regionOf — метка (СПБ/МСК/КРД) в ФИО и правило номера логиста.
 *  3. parseFilters / matchRow — валидация периода, фильтры региона/логиста/статуса.
 *  4. buildSummary — М1, М2 (МСК-дата), М3, М4, М6–М9, М11, М5 и разрез по регионам.
 *  5. #8126: дрилл «Ответов» по колонке, сортировка в URL, форматы DS, человеческие
 *     имена, метрики сводки логистов (те же числа, что buildSummary, доли — формулой).
 * Запуск: npm run test:realizations
 */
import { canViewRealizations } from '../lib/realizations/access.ts';
import { regionOf } from '../lib/realizations/region.ts';
import { parseFilters, matchRow } from '../lib/realizations/filters.ts';
import { buildSummary, statusTimes, median, percentile, mskDate, type ReqRow } from '../lib/realizations/metrics.ts';
import { RESPONSE_DRILL_RULES, responseDrillRule, parseDrillMetric } from '../lib/realizations/responseDrill.ts';
import { RESPONSE_METRICS } from '../lib/realizations/responseMetrics.ts';
import { LOGIST_METRICS, LOGIST_COLUMN_GROUPS, LOGIST_DEFAULT_METRIC_IDS, LOGIST_HEATMAP_ON_IDS, LOGIST_HEATMAP_INVERTED_IDS, summaryToMetrics } from '../lib/realizations/logistMetrics.ts';
import { computeCalculated } from '../features/reports/engine/calculated.ts';
import { parseSortParam, nextSort, sortRows } from '../lib/hooks/sortCore.ts';
import { fmtRub, fmtInt, fmtMlnRub, fmtPct, humanName } from '../features/realizations/ui/format.ts';
import { mskYmd } from '../lib/realizations/period.ts';

let failures = 0, passed = 0;
function check(cond: boolean, label: string) { if (cond) { passed++; return; } failures++; console.error(`FAIL ${label}`); }
const near = (a: number | null, b: number, eps = 1e-6) => a !== null && Math.abs(a - b) < eps;

// 1. Доступ
check(canViewRealizations({ isSuperadmin: false, roleName: 'Администратор' }), 'админ проходит');
check(canViewRealizations({ isSuperadmin: true, roleName: null }), 'супер-админ проходит');
check(!canViewRealizations({ isSuperadmin: false, roleName: 'РОП' }), 'РОП не проходит');
check(!canViewRealizations({ isSuperadmin: false, roleName: 'Директор' }), 'Директор не проходит');
check(!canViewRealizations({ isSuperadmin: false, roleName: 'администратор ' }), 'похожая роль не проходит');
check(!canViewRealizations(null), 'без сессии не проходит');

// 2. Регион
check(regionOf('Глимнурова Эльвина (СПБ) Л106') === 'СПБ', 'метка СПБ');
check(regionOf('Рыбальченко Кирилл (СПб) Л3') === 'СПБ', 'метка СПб в другом регистре');
check(regionOf('Исаковский Алексей (МСК) Л2201') === 'МСК', 'метка МСК');
check(regionOf('Кирилюк Анатолий (КРД) Л303') === 'КРД', 'метка КРД');
check(regionOf('Иванов Игорь (СПБ) Л2') === 'СПБ', 'метка важнее номера (Л2 = Логист02)');
check(regionOf('Без Метки Л2201') === 'МСК', 'номер 2** → МСК');
check(regionOf('Без Метки Л301') === 'КРД', 'номер 3** → КРД');
check(regionOf('Без Метки Л106') === 'СПБ', 'номер 1** → СПБ');
check(regionOf('Без Метки Л7') === 'СПБ', 'короткий номер → СПБ');
check(regionOf('Афанасьев Сергей Витальевич') === 'Без региона', 'не логист → без региона');
check(regionOf(null) === 'Без региона', 'пусто → без региона');

// 3. Фильтры
const now = new Date('2026-09-29T09:00:00Z');
const f0 = parseFilters(new URLSearchParams(''), now);
check(!('error' in f0) && f0.from === '2026-08-31' && f0.to === '2026-09-29', 'дефолтный период 30 дней');
check('error' in parseFilters(new URLSearchParams('from=2026-09-10&to=2026-09-01'), now), 'from > to — ошибка');
check('error' in parseFilters(new URLSearchParams("from=2026-09-10'&to=2026-09-11"), now), 'мусор в дате — ошибка');
check('error' in parseFilters(new URLSearchParams('from=2024-01-01&to=2026-01-01'), now), 'период > года — ошибка');
const f1 = parseFilters(new URLSearchParams('region=МСК&logist=abc&status=grp:shipped'), now);
check(!('error' in f1) && f1.region === 'МСК' && f1.logist === null && f1.status === 'grp:shipped', 'регион ок, мусорный логист отброшен');
const rowMsk = { logist_id: '11111111-1111-1111-1111-111111111111', logist: 'X (МСК) Л2201', status: 'Отгружено', grp: 'shipped' as const };
check(matchRow(rowMsk, { region: 'МСК', logist: null, status: 'grp:shipped' }), 'match регион+группа');
check(!matchRow(rowMsk, { region: 'СПБ', logist: null, status: null }), 'чужой регион отсечён');
check(!matchRow(rowMsk, { region: null, logist: null, status: 'Выполнено' }), 'точный статус');
check(matchRow({ ...rowMsk, logist_id: null }, { region: null, logist: '__none', status: null }), 'логист не указан');

// 4. Сводка
const base: ReqRow = {
  id: 'r', number: '1', doc_date: null, status: 'Отгружено', grp: 'shipped', buyer: null, manager: null,
  logist_id: 'L1', logist: 'А (СПБ) Л106', shipment_date: '2026-09-10', creation_date_1c: '2026-09-01T09:00:00Z',
  sales_nv: 1000, sales_vat: 1200, d_sale: 100, purchases_n: 1, broken: false, purch_nv: 800, d_cost: 150,
  first_ship: '2026-09-10T20:30:00Z', first_new: '2026-09-05T09:00:00Z', first_take: '2026-09-05T11:00:00Z', had_fix: false,
};
const rows: ReqRow[] = [
  // в срок: 20:30Z 10.09 = 23:30 МСК 10.09 ≤ плана
  { ...base, id: 'a' },
  // не в срок: 21:30Z 10.09 = 00:30 МСК 11.09 > плана 10.09
  { ...base, id: 'b', first_ship: '2026-09-10T21:30:00Z', had_fix: true, broken: true },
  // отгружено без приобретения и без истории — выпадает из М2/М3, в М7
  { ...base, id: 'c', purchases_n: 0, purch_nv: null, first_ship: null, first_new: null, first_take: null, sales_nv: 500 },
  { ...base, id: 'd', grp: 'cancelled', status: 'Отмена', first_ship: null, sales_nv: 9999 },
  { ...base, id: 'e', grp: 'in_work', status: 'Взята в работу', first_ship: null, logist_id: 'L2', logist: 'Б (МСК) Л2201', first_take: '2026-09-05T13:00:00Z' },
];
check(mskDate('2026-09-10T21:30:00Z') === '2026-09-11', 'МСК-дата после полуночи');
const names = new Map([['L1', 'А (СПБ) Л106'], ['L2', 'Б (МСК) Л2201']]);
const od = [{ logist_id: 'L1', shipment_date: '2026-08-01' }, { logist_id: 'L1', shipment_date: '2026-09-20' }, { logist_id: 'L2', shipment_date: '2026-09-25' }];
const s = buildSummary(rows, od, 'logist', '2026-09-29', names);
const a = s.rows.find(r => r.key === 'L1')!;
check(a.total === 4 && a.shipped === 3 && a.cancelled === 1 && a.inWork === 0, 'М1 по логисту');
check(near(a.cancelPct, 25), 'М1 доля отмен');
check(a.shipWithHist === 2 && near(a.onTimePct, 50), 'М2 в срок по МСК-дате');
check(a.fixPct !== null && near(a.fixPct, 100 / 3), 'М6 правки');
check(a.shippedNoPurchase === 1, 'М7 без приобретения');
check(a.salesNv === 2500 && near(a.avgCheckNv, 2500 / 3), 'М8 выручка и чек (отмена не входит)');
check(a.marginBaseN === 1 && a.exclBroken === 1 && a.marginNv === 200 && near(a.marginPct, 20), 'М9 маржа без задвоенных');
check(a.dSale === 200 && a.dCost === 300, 'М11 доставка: a + c, задвоенная b исключена');
check(a.overdue === 2 && a.overdue30 === 1 && a.oldestOverdue === '2026-08-01', 'М5 просрочки');
check(s.total.total === 5 && s.total.overdue === 3, 'Итого');
check(near(s.total.reactHoursMed, 2), 'М4 реакция медиана'); // 2,2,(c без истории),2,4 → [2,2,2,4] → 2
const rg = buildSummary(rows, od, 'region', '2026-09-29', names);
check(rg.rows.length === 2 && rg.rows.find(r => r.key === 'МСК')?.total === 1 && rg.rows.find(r => r.key === 'СПБ')?.overdue === 2, 'разрез по регионам');
check(median([3, 1, 2]) === 2 && median([1, 2, 3, 4]) === 2.5 && median([]) === null, 'медиана');
check(near(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1), 'p90 как percentile_cont');
const st = statusTimes([...Array(25)].map((_, i) => ({ logist_id: 'L1', status: 'Новая заявка', hours: i })).concat([{ logist_id: 'L1', status: 'Редкий', hours: 1 }]));
check(st.length === 1 && st[0].n === 25 && st[0].medianH === 12, 'М4 время в статусах, редкие скрыты');
const empty = buildSummary([], [], 'logist', '2026-09-29', names);
check(empty.rows.length === 0 && empty.total.total === 0 && empty.total.onTimePct === null && empty.total.marginPct === null, 'пустые данные без NaN');


// 5. Задача #8126
// 5.1 Дрилл «Ответов»: у каждой метрики отчёта есть правило; неизвестный id не проходит в SQL.
check(RESPONSE_METRICS.every(m => RESPONSE_DRILL_RULES[m.id]), 'правило дрилла у каждой rr_* метрики');
check(parseDrillMetric('rr_requests_new') === 'rr_requests_new' && parseDrillMetric("x'; drop") === null && parseDrillMetric(null) === null, 'metricId только из словаря');
check(responseDrillRule('rr_requests_new').where === 'rq.status in (1, 2)', 'новые = статус 1, 2 (как в агрегате)');
check(responseDrillRule(undefined).where === '' && responseDrillRule('нет такой').where === '', 'без метрики — все запросы');
check(responseDrillRule('rr_sold_deals').perDeal === true && responseDrillRule('rr_sold_deals').unit === 'deals', 'сделочные метрики — строка на сделку');
check(Object.values(RESPONSE_DRILL_RULES).every(r => !/;|--/.test(r.where)), 'условия без ; и комментариев');
// 5.2 Сортировка: цикл убывание → возрастание → по умолчанию, разбор параметра
check(JSON.stringify(nextSort({ key: null, dir: 'desc' }, 'a')) === '{"key":"a","dir":"desc"}', 'первый клик — убывание');
check(nextSort({ key: 'a', dir: 'desc' }, 'a').dir === 'asc' && nextSort({ key: 'a', dir: 'asc' }, 'a').key === null, 'второй — возрастание, третий — сброс');
check(parseSortParam('salesNv:asc', ['salesNv'] as const)?.dir === 'asc' && parseSortParam('evil:asc', ['salesNv'] as const) === null, 'параметр сортировки из белого списка');
const srt = sortRows([{ v: 2 }, { v: null }, { v: 5 }], { key: 'v', dir: 'desc' }, (r, _k) => r.v);
check(srt.map(r => r.v).join(',') === '5,2,', 'пустые значения — внизу');
// 5.3 Форматы DS: минус U+2212, «млн ₽» с одним знаком
check(fmtRub(-480000) === '\u2212480\u00a0000\u00a0₽', 'минус — U+2212, полная сумма');
check(fmtMlnRub(355_100_000) === '355,1\u00a0млн\u00a0₽' && fmtMlnRub(0) === '0\u00a0₽', 'KPI млн ₽ с одним знаком');
check(fmtInt(null) === '—' && fmtPct(12.34) === '12,3\u00a0%', 'пусто — тире, проценты');
check(humanName('Менеджер2913 (Королькова)') === 'Королькова (Менеджер2913)', 'техимя → фамилия первой');
check(humanName('- - 3404') === null && humanName('') === null && humanName('ООО Ромашка') === 'ООО Ромашка', 'мусорные имена → «Без покупателя»');
check(mskYmd(new Date('2026-08-31T21:00:00.000Z')) === '2026-09-01' && mskYmd(new Date('2026-09-28T20:59:59.999Z')) === '2026-09-28', 'границы МСК-суток');
// 5.4 Сводка логистов на движке: те же числа, что buildSummary (доли — формулой по счётчикам)
const calc = LOGIST_METRICS.filter(m => m.metricType === 'calculated');
for (const r of [...s.rows, s.total]) {
  const raw = summaryToMetrics(r);
  const out = computeCalculated(raw, calc);
  const same = (a: number | null | undefined, b: number | null) => (b === null ? a === null || a === undefined : near(a ?? null, b, 1e-6));
  check(same(out.lg_cancel_pct, r.cancelPct) && same(out.lg_on_time_pct, r.onTimePct) && same(out.lg_fix_pct, r.fixPct)
    && same(out.lg_margin_pct, r.marginPct) && same(out.lg_avg_check, r.avgCheckNv) && same(out.lg_d_ratio, r.dCostToSalePct),
    `доли логиста ${r.key} совпадают с buildSummary`);
  check(out.lg_total === r.total && out.lg_overdue === r.overdue && out.lg_margin === r.marginNv && out.lg_excl_broken === r.exclBroken, `счётчики ${r.key}`);
}
check(LOGIST_METRICS.every(m => !/М\d|integrity|зеркал/i.test(`${m.nameRu} ${m.description}`)), 'подписи метрик без кодов М и жаргона');
const grouped = new Set(LOGIST_COLUMN_GROUPS.flatMap(g => g.metricIds));
check(LOGIST_DEFAULT_METRIC_IDS.every(id => grouped.has(id)), 'каждая видимая колонка — в группе');

// 5.5 Раскраска: где больше = хуже — шкала инвертирована (доработка #8126)
for (const id of ['lg_cancel_pct', 'lg_fix_pct', 'lg_d_ratio', 'lg_overdue', 'lg_overdue30', 'lg_no_purchase', 'lg_excl_broken'])
  check(LOGIST_HEATMAP_INVERTED_IDS.includes(id), `«больше = хуже»: ${id} красится инвертированно`);
check(!LOGIST_HEATMAP_INVERTED_IDS.includes('lg_on_time_pct') && !LOGIST_HEATMAP_INVERTED_IDS.includes('lg_margin_pct'), 'в срок и маржа — обычная шкала (больше = лучше)');
check(LOGIST_HEATMAP_ON_IDS.every(id => LOGIST_METRICS.some(m => m.id === id && m.dataType !== 'percent')), 'явный градиент — только у счётчиков (доли и так с градиентом)');

console.log(`assert-realizations: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
