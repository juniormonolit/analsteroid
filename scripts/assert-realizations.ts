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
import { LOGIST_METRICS, LOGIST_COLUMN_GROUPS, LOGIST_DEFAULT_METRIC_IDS, LOGIST_HEATMAP_ON_IDS, LOGIST_HEATMAP_INVERTED_IDS, summaryToMetrics, needsCallUpgrade, upgradeLogistView } from '../lib/realizations/logistMetrics.ts';
import { computeCalculated } from '../features/reports/engine/calculated.ts';
import { parseSortParam, nextSort, sortRows } from '../lib/hooks/sortCore.ts';
import { fmtRub, fmtInt, fmtMlnRub, fmtPct, humanName } from '../features/realizations/ui/format.ts';
import { mskYmd } from '../lib/realizations/period.ts';
import { aggregateCallsJs, callAggToMetrics, callLogists, resolveCallLogist, callWorkdays, callDrillWhere, maskPhone, toCallAgg, sqlCallList, SQL_CALL_AGG, SQL_CALL_LOGIST_MAP, CALL_METRICS, CALL_COLUMN_GROUP, EMPTY_CALL_AGG, type CallMapRow } from '../lib/realizations/callMetrics.ts';

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

// 6. Звонки логистов (#8314): агрегат, раскладка по метрикам, доли формулой, мост Bitrix → 1С
const calls = [
  { direction: 'outbound', duration_seconds: 45, failed_code: '200', transcription_status: 'transcribed', phone: '+79110000001' },
  { direction: 'outbound', duration_seconds: 0, failed_code: '480', transcription_status: 'skipped', phone: '+79110000002' },
  { direction: 'inbound', duration_seconds: 433, failed_code: '200', transcription_status: 'transcribed', phone: '+79110000001' },
  { direction: 'inbound', duration_seconds: 17, failed_code: '304', transcription_status: 'skipped', phone: '+79110000003' },
  { direction: 'inbound', duration_seconds: 5, failed_code: '200', transcription_status: 'queued', phone: '+79110000004' },
  { direction: 'inbound', duration_seconds: 0, failed_code: null, transcription_status: null, phone: null },
];
const ca = aggregateCallsJs(calls);
check(ca.total === 6 && ca.nOut === 2 && ca.nIn === 4, 'звонки: всего / исх / вх');
check(ca.secOut === 45 && ca.secIn === 438, 'звонки: секунды исх / вх — только состоявшиеся (дозвон пропущенного 17 с не в счёт)');
check(ca.secOut + ca.secIn === ca.secAnswered, 'минуты исх + вх = минуты состоявшихся');
check(ca.answered === 3 && ca.secAnswered === 483 && ca.inAnswered === 2, 'состоявшиеся = код 200');
check(ca.inMissed === 2, 'пропущенные входящие: код ≠ 200, в т.ч. без кода');
check(ca.shortN === 1 && ca.transcribedN === 2 && ca.phones === 4, 'короткие < 10 с среди состоявшихся, расшифровка, уникальные номера');
const cm = computeCalculated(callAggToMetrics(ca, 4), CALL_METRICS.filter(m => m.metricType === 'calculated'));
check(near(cm.lc_out_min, 0.75) && near(cm.lc_in_min, 438 / 60), 'минуты исх/вх');
check(near(cm.lc_avg_talk_min, 483 / 60 / 3), 'средний разговор, мин — формулой = прямому счёту');
check(near(cm.lc_answered_in_pct, 50) && near(cm.lc_short_pct, 100 / 3) && near(cm.lc_transcribed_pct, 200 / 3), 'доли отвеченных входящих, коротких, с расшифровкой');
check(near(cm.lc_per_workday, 1.5), 'звонков в рабочий день = всего / рабочие дни');
const raw = callAggToMetrics(ca, 4);
for (const m of CALL_METRICS.filter(x => x.metricType === 'calculated')) check(near(cm[m.id], raw[m.id] as number), `формула ${m.id} = прямой счёт`);
check(Object.values(callAggToMetrics(null, 4)).every(v => v === null), 'без учётки Битрикса — «—», не нули');
const zero = computeCalculated(callAggToMetrics(EMPTY_CALL_AGG, 4), CALL_METRICS.filter(m => m.metricType === 'calculated'));
check(zero.lc_total === 0 && zero.lc_answered_in_pct === null && zero.lc_avg_talk_min === null, 'ноль звонков — счётчики 0, доли без деления на ноль');
check(toCallAgg({ total: '3', n_out: 1, sec_out: '12.5' }).total === 3 && toCallAgg({ sec_out: '12.5' }).secOut === 12.5, 'строка SQL → агрегат');
// Подытог региона: доли — формулой по суммам счётчиков, а не среднее долей
const a1 = aggregateCallsJs(calls.slice(0, 2)), a2 = aggregateCallsJs(calls.slice(2));
const sum = Object.fromEntries(Object.keys(EMPTY_CALL_AGG).map(k => [k, (a1 as never)[k] + (a2 as never)[k]])) as typeof ca;
check(near(computeCalculated(callAggToMetrics(sum, 4), CALL_METRICS.filter(m => m.metricType === 'calculated')).lc_avg_talk_min, 483 / 60 / 3), 'подытог: средний разговор из сумм');
// Рабочие дни: с 30.09.2026, не позже сегодня, производственный календарь
check(callWorkdays('2026-09-01', '2026-09-30', '2026-09-30') === 1, 'сентябрь: данные только за 30.09 → 1 рабочий день');
check(callWorkdays('2026-10-01', '2026-10-31', '2026-10-31') === 22, 'октябрь 2026 — 22 рабочих дня');
check(callWorkdays('2026-10-01', '2026-10-31', '2026-10-05') === 3, 'текущий месяц обрезан сегодняшним днём (1, 2, 5 окт.)');
check(callWorkdays('2026-09-01', '2026-09-20', '2026-09-30') === 0, 'период до начала данных — 0 дней');
check(callWorkdays('2026-11-02', '2026-11-06', '2026-12-01') === 4, '4 ноября — праздник');
// Мост #8357: va.logist_bitrix_map с интервалами — логист на учётке в момент звонка
const MAP8357: CallMapRow[] = [
  { logistId: 'marina', bitrixId: '7450', name: 'Марьина Мария (МСК) Л2004', validFrom: '2023-12-31T21:00:00.000Z', validTo: '2026-08-04T01:00:10.369Z' },
  { logistId: 'tkachev', bitrixId: '2000', name: 'Ткачев Кирилл (СПБ) Л109', validFrom: '2023-12-31T21:00:00.000Z', validTo: null },
  { logistId: 'kach', bitrixId: '2004', name: 'Качанова Инна (СПБ) Л111', validFrom: '2023-12-31T21:00:00.000Z', validTo: null },
  { logistId: 'nest', bitrixId: '7460', name: 'Нестеров Юрий (МСК) Л2214', validFrom: '2026-08-20T01:00:06.056Z', validTo: null },
  { logistId: 'bad', bitrixId: 'x', name: 'мусор', validFrom: '2023-12-31T21:00:00.000Z', validTo: null },
];
check(resolveCallLogist(MAP8357, '7450', '2026-07-29T10:00:00Z') === 'marina' && resolveCallLogist(MAP8357, '7450', '2026-09-30T10:00:00Z') === null, 'учётка перешла: звонок до valid_to — логисту, после — никому');
check(resolveCallLogist(MAP8357, '7450', '2026-08-04T01:00:10.369Z') === null && resolveCallLogist(MAP8357, '7460', '2026-08-20T01:00:06.056Z') === 'nest', 'valid_to не включается, valid_from включается');
check(resolveCallLogist(MAP8357, '2000', '2026-09-30T12:00:00Z') === 'tkachev' && resolveCallLogist(MAP8357, '9999', '2026-09-30T12:00:00Z') === null && resolveCallLogist(MAP8357, '2000', null) === null, 'резолв по учётке и времени; чужая учётка и пустое время — никому');
const lgSep = callLogists(MAP8357, '2026-09-01', '2026-09-30');
check(lgSep.has('tkachev') && lgSep.has('nest') && !lgSep.has('marina') && !lgSep.has('bad') && lgSep.get('nest')?.region === 'МСК', 'в периоде: учётка сдана раньше — «—»; нечисловой id отброшен; регион по ФИО');
check(callLogists(MAP8357, '2026-08-01', '2026-08-03').has('marina') && !callLogists(MAP8357, '2026-08-01', '2026-08-19').has('nest'), 'пересечение периода и интервала — по московским суткам');
check(/lm\.valid_from/.test(SQL_CALL_AGG) && /c\.started_at < lm\.valid_to/.test(SQL_CALL_AGG) && /va\.logist_bitrix_map/.test(sqlCallList('')) && !/disp\./.test(SQL_CALL_AGG + sqlCallList('') + SQL_CALL_LOGIST_MAP), 'SQL: резолв через va.logist_bitrix_map по started_at, disp не читаем');
// ПДн и SQL
check(maskPhone('+79111234567') === '••• 45-67' && maskPhone(null) === null && maskPhone('12') === '••••', 'номер — только последние 4 цифры');
check(!/\d{5}/.test(maskPhone('+79111234567') ?? ''), 'в маске нет длинных цифр');
check(callDrillWhere('lc_missed_in').where.includes("'inbound'") && callDrillWhere('lc_total').where === '' && callDrillWhere('lg_total').where === '', 'дрилл: условие по колонке, «всего» — без условия');
check(/grouping sets \(\(m\.k\), \(\)\)/.test(SQL_CALL_AGG) && /at time zone 'Europe\/Moscow'/.test(SQL_CALL_AGG), 'SQL: итог grouping set (), московские сутки');
check(!/recording_url|raw_text|formatted_dialogue/.test(SQL_CALL_AGG + sqlCallList('x')), 'SQL: записи и тексты разговоров не читаем');
check(CALL_COLUMN_GROUP.metricIds.every(id => CALL_METRICS.some(m => m.id === id && !m.isHiddenInUi)) && CALL_COLUMN_GROUP.metricIds.length === 12, 'группа «Звонки» — 12 видимых колонок');
check(CALL_METRICS.every(m => m.description && m.description.length > 20), 'у каждой метрики звонков есть описание');
check(LOGIST_DEFAULT_METRIC_IDS.includes('lc_total') && LOGIST_HEATMAP_INVERTED_IDS.includes('lc_missed_in') && LOGIST_HEATMAP_INVERTED_IDS.includes('lc_short_pct'), 'звонки в колонках по умолчанию; пропущенные/короткие — «больше = хуже»');

// 6.1 Старые вкладки/отчёты (до #8314) получают группу «Звонки», выбор пользователя со звонками — нет
const OLD = LOGIST_DEFAULT_METRIC_IDS.filter(id => id.startsWith('lg_'));
check(needsCallUpgrade(OLD) && needsCallUpgrade(['lg_total']) && !needsCallUpgrade([]) && !needsCallUpgrade(['lg_total', 'lc_total']) && !needsCallUpgrade(['all_core']), 'апгрейд вида: только чистые lg_-виды');
const upv = upgradeLogistView({ metricIds: OLD, columnGroups: LOGIST_COLUMN_GROUPS.filter(g => g.name !== 'Звонки'), heatmapOn: ['lg_overdue'], heatmapInverted: ['lg_cancel_pct'] });
check(upv.metricIds.length === OLD.length + 12 && upv.metricIds.slice(0, OLD.length).join() === OLD.join(), 'апгрейд: звонки дописаны в конец, порядок старых колонок сохранён');
check(upv.columnGroups.some(g => g.name === 'Звонки') && upv.heatmapOn.includes('lc_missed_in') && upv.heatmapInverted.includes('lc_short_pct') && upv.heatmapOn.includes('lg_overdue'), 'апгрейд: группа и раскраска звонков');
check(upgradeLogistView({ metricIds: upv.metricIds, columnGroups: upv.columnGroups, heatmapOn: [], heatmapInverted: [] }).columnGroups.length === upv.columnGroups.length, 'апгрейд идемпотентен');

console.log(`assert-realizations: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
