// Задача 11110: стаж по человеку на учётке, а не по учётке.
// Истории — реальные формы учёток 2045, 1916, 2037 с прода (28.10), имена как есть
// в sa.employee_name_history. Запуск: npm run test:person-segment
import assert from 'node:assert/strict';
import {
  isPlaceholderName, personKey, samePerson, currentPersonSegment, resolveTenure, xpPersonBoundary,
  type NameHistoryRow,
} from '../features/employees/engine/personSegment.ts';
import { isOwnerChange, ownerChangeText } from '../lib/org/tenureNotify.ts';

// ── Заглушки = вакансия ──
for (const s of ['manager68', 'Manager119', 'User 2045', 'Caller13', 'caller6', 'studentos1', 'Studentos2', 'studentnc9',
  'logist101', 'Logist2004', 'ЛогистБух2', 'RH1', 'ROPNK1', 'ROPOS4', 'ROPYL2', 'rop2', 'SDD2', 'sdd1', 'SDR1', 'OK3',
  'Proger1', 'testuser1', 'Менеджер 142', 'Менеджер2213', 'manager 307', 'manager2929 manager2929', 'Логист301 Логист301',
  'УДАЛИТЬ', 'ROSNC', 'mltadmin', 'AI', '', '  ']) {
  assert.ok(isPlaceholderName(s), `заглушка: «${s}»`);
}
for (const s of ['Елена Шарафисламова', 'Вячеслав Скворцов (МСК 2013)', 'Мария Жевагина (ЛБ7)', 'manager2916 Юлия',
  'ОТКАЗАТЬ Caller27 (Милана)', 'Елена', 'Виктория Крапиве́нко', 'Генерал Спецназа (РОПОС3)']) {
  assert.ok(!isPlaceholderName(s), `человек: «${s}»`);
}

// ── Ключ человека ──
assert.equal(personKey('Вячеслав Скворцов (РОПМСКНЦ)'), personKey('Вячеслав  Скворцов (МСК 2013)'));
assert.equal(personKey('Виктория Крапиве́нко'), personKey('виктория крапивенко'));
assert.equal(personKey('Пётр Ёлкин'), personKey('Петр Елкин'));
assert.notEqual(personKey('Тимур Хакимов'), personKey('Анастасия Сусликова'));
assert.ok(samePerson('Алексей Исаковский', 'Алексей В ОТПУСКЕ Исаковский'), 'пометка вне скобок');
assert.ok(samePerson('ОКсана Власова', 'Оксана Власова'));
assert.ok(!samePerson('Анастасия Гурьянова', 'Анастасия Большакова'));
assert.ok(!samePerson('Елена', 'Елена Шарафисламова'), 'одно имя — не человек целиком');

const h = (rows: [string, string, string | null][]): NameHistoryRow[] =>
  rows.map(([name, from, to]) => ({ name, validFrom: `${from}T01:00:00.000Z`, validTo: to ? `${to}T01:00:00.000Z` : null }));

const acc2045 = h([
  ['Виктория Дунаева', '2026-07-13', '2026-07-17'], ['Борис Китов', '2026-07-17', '2026-07-23'],
  ['manager68', '2026-07-23', '2026-07-25'], ['Стасов Дмитрий', '2026-07-25', '2026-07-27'],
  ['User 2045', '2026-07-27', '2026-07-28'], ['manager68', '2026-07-28', '2026-07-29'],
  ['Алина Гурьянова', '2026-07-29', '2026-07-31'], ['manager68', '2026-07-31', '2026-08-01'],
  ['Денис Силаев', '2026-08-01', '2026-08-29'], ['Тимур Хакимов', '2026-08-29', '2026-10-21'],
  ['manager68', '2026-10-21', '2026-10-23'], ['Анастасия Сусликова', '2026-10-23', '2026-10-27'],
  ['User 2045', '2026-10-27', '2026-10-28'], ['manager68', '2026-10-28', null],
]);
const acc1916 = h([
  ['Александр Сухарев', '2026-07-13', '2026-10-01'], ['Дмитрий Резник', '2026-10-01', '2026-10-06'],
  ['User 1916', '2026-10-06', '2026-10-08'], ['Manager119', '2026-10-08', '2026-10-09'],
  ['Людмила Гончарова', '2026-10-09', '2026-10-20'], ['Manager119', '2026-10-20', '2026-10-28'],
  ['Елена Шарафисламова', '2026-10-28', null],
]);
const acc2037 = h([['Владислав Пшеничный', '2026-07-13', '2026-10-28'], ['manager60', '2026-10-28', null]]);
const stable = h([['Ольга Иванова', '2026-07-13', null]]);
const newAccount = h([['Пётр Новиков', '2026-09-01', null]]);

// ── Отрезок текущего человека ──
const s2045 = currentPersonSegment(acc2045)!;
assert.equal(s2045.vacant, true, '2045 — вакансия');
assert.equal(s2045.startDate, '2026-10-27', '2045 — вакансия идёт с User 2045 (заглушки подряд — одна вакансия)');

const s1916 = currentPersonSegment(acc1916)!;
assert.deepEqual([s1916.vacant, s1916.name, s1916.startDate, s1916.knownStart], [false, 'Елена Шарафисламова', '2026-10-28', true]);

const s2037 = currentPersonSegment(acc2037)!;
assert.equal(s2037.vacant, true);

const sStable = currentPersonSegment(stable)!;
assert.equal(sStable.knownStart, false, 'с засевки 13.07 — настоящее начало неизвестно');
assert.equal(currentPersonSegment(newAccount)!.knownStart, false, 'первое появление учётки (напр. добор глав 30.07) — начало неизвестно');
assert.equal(currentPersonSegment([]), null);

// Тот же человек с косметической правкой ФИО — отрезок не рвётся.
const cosmetic = h([['Иван Петров', '2026-07-13', '2026-08-01'], ['Иван Петров (РОП)', '2026-08-01', null]]);
assert.equal(currentPersonSegment(cosmetic)!.knownStart, false);
// Вернулся после заглушки — новый отрезок.
const back = h([['Иван Петров', '2026-07-13', '2026-08-01'], ['manager5', '2026-08-01', '2026-09-01'], ['Иван Петров', '2026-09-01', null]]);
assert.equal(currentPersonSegment(back)!.startDate, '2026-09-01');

// ── Стаж (реестр без фолбэка / профиль с фолбэком) ──
// 2045: дата 26.02 стояла у «Денис Силаев» (внесена 01.08) → сейчас вакансия, стажа нет.
let t = resolveTenure('2026-02-26', 'Денис Силаев', s2045, false);
assert.deepEqual([t.startDate, t.manualStale, t.vacant], [null, true, true]);
// 1916: дата 28.04 от «Александр Сухарев» → «не заполнено»; профиль — с 28.10.
t = resolveTenure('2026-04-28', 'Александр Сухарев', s1916, false);
assert.deepEqual([t.startDate, t.manualStale], [null, true]);
t = resolveTenure('2026-04-28', 'Александр Сухарев', s1916, true);
assert.deepEqual([t.startDate, t.source], ['2026-10-28', 'segment']);
// Дата при текущем ФИО — действует.
t = resolveTenure('2026-10-29', 'Елена Шарафисламова', s1916, false);
assert.deepEqual([t.startDate, t.source, t.manualStale], ['2026-10-29', 'manual', false]);
// Стабильная учётка, дата без ФИО (до миграции) — действует.
t = resolveTenure('2024-03-01', null, sStable, false);
assert.equal(t.startDate, '2024-03-01');
// Стабильная учётка, ручной даты нет — профиль не выдумывает 13.07.
t = resolveTenure(null, null, sStable, true);
assert.equal(t.startDate, null);
// Истории нет — верим ручной дате.
assert.equal(resolveTenure('2025-01-10', null, null, false).startDate, '2025-01-10');

// ── XP: более поздняя из (ручная дата, начало текущего ФИО) ──
assert.equal(xpPersonBoundary('2026-04-28', s1916), '2026-10-28', '1916: XP Сухарева не переходит Шарафисламовой');
assert.equal(xpPersonBoundary('2026-11-01', s1916), '2026-11-01');
assert.equal(xpPersonBoundary('2024-03-01', sStable), '2024-03-01', 'засевка 13.07 ретро не режет');
assert.equal(xpPersonBoundary(null, sStable), null);
assert.equal(xpPersonBoundary('2026-02-26', s2045), '2026-10-27', 'вакансия: XP предшественника заморожен');

// ── Пуш РОПу ──
assert.ok(isOwnerChange('Manager119', 'Елена Шарафисламова'));
assert.ok(isOwnerChange('Тимур Хакимов', 'Анастасия Сусликова'));
assert.ok(!isOwnerChange('Владислав Пшеничный', 'manager60'), 'уход в заглушку — не пушим');
assert.ok(!isOwnerChange('Иван Петров', 'Иван Петров (РОП)'), 'косметика — не пушим');
assert.ok(!isOwnerChange('Алексей Исаковский', 'Алексей В ОТПУСКЕ Исаковский'), 'отпуск — не пушим');
const txt = ownerChangeText([{ bitrixId: '1916', prevName: 'Manager119', newName: 'Елена Шарафисламова', ropId: '7' }]);
assert.ok(txt.includes('учётка сменила хозяина') && txt.includes('/employees?q=1916') && txt.includes('была свободна'), txt);
assert.ok(!/начальств|наруш|штраф/i.test(txt), 'тон — кореш, не надзиратель');
const txt2 = ownerChangeText([
  { bitrixId: '1', prevName: 'А Б', newName: 'В Г', ropId: '7' },
  { bitrixId: '2', prevName: 'manager2', newName: 'Д Е', ropId: '7' },
]);
assert.ok(txt2.includes('2 учётки сменили хозяина') && txt2.includes('была за «А Б»'), txt2);

console.log('person-segment: OK');
