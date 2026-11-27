// Задачник: чистые функции времени (собрание 26.11 — лента занятости, несколько дат, тексты бота).
// npm run test:tasker
import assert from 'node:assert/strict';
import { fmtWhen, freeWindows, slotsOverlap } from '../features/tasker/engine/when';

const at = (hm: string, ymd = '2026-12-01') => Date.parse(`${ymd}T${hm}:00+03:00`);
const early = Date.parse('2026-11-30T12:00:00Z'); // «сейчас» — накануне

// fmtWhen: МСК, день недели
assert.equal(fmtWhen(new Date(at('15:00')).toISOString(), new Date(at('15:30')).toISOString()), 'вт 01.12, 15:00–15:30');

// freeWindows: пустой день — одно окно 9–19
assert.deepEqual(freeWindows('2026-12-01', [], 30, early), [{ start: at('09:00'), end: at('19:00') }]);
// занято 10:00–10:30 и 15:00–15:30 (пересекающиеся тоже) — три окна
const w = freeWindows('2026-12-01', [{ start: at('15:00'), end: at('15:30') }, { start: at('10:00'), end: at('10:30') }, { start: at('10:15'), end: at('10:20') }], 30, early);
assert.deepEqual(w.map(x => [x.start, x.end]), [[at('09:00'), at('10:00')], [at('10:30'), at('15:00')], [at('15:30'), at('19:00')]]);
// короткая щель меньше длительности — не окно
assert.equal(freeWindows('2026-12-01', [{ start: at('09:00'), end: at('12:00') }, { start: at('12:20'), end: at('19:00') }], 30, early).length, 0);
// конец занятости не по сетке — начало окна округляется вверх до 15 минут
assert.equal(freeWindows('2026-12-01', [{ start: at('09:00'), end: at('09:40') }], 30, early)[0].start, at('09:45'));
// прошедшее время не предлагается: «сейчас» 13:07 → окна с 13:30
assert.equal(freeWindows('2026-12-01', [], 30, at('13:07'))[0].start, at('13:30'));

// slotsOverlap
assert.equal(slotsOverlap([at('15:00'), at('15:00', '2026-12-03')], 30), false); // вт + чт
assert.equal(slotsOverlap([at('15:00'), at('15:20')], 30), true);
assert.equal(slotsOverlap([at('15:30'), at('15:00')], 30), false); // встык

console.log('assert-tasker-time: OK');
