// Моковые данные Задачника — только для dev (?mock=1): проверка экранов без API и входа.
// Форма — строго по контракту features/tasker/types.ts.
import type { TaskerMetric, TaskerPerson, TaskerSession, TaskerStatus, TaskerTask, TaskerTasksResponse, TaskerVerdict, TrainingEnrollment } from '../../types';
import { addDays, mondayOf, todayMsk } from './format';

export const MOCK_METRICS: TaskerMetric[] = [
  { id: 'cr_deal_sale', label: 'CR Сделка → Продажа', group: 'conversion', higherIsBetter: true, format: 'percent', tag: 'CR Сделка→Продажа', sortOrder: 1 },
  { id: 'cr_ppp', label: 'CR ППП', group: 'conversion', higherIsBetter: true, format: 'percent', tag: 'CR ППП', sortOrder: 2 },
  { id: 'avg_check_calc', label: 'Ср. чек (все)', group: 'check', higherIsBetter: true, format: 'money', tag: 'Ср. чек', sortOrder: 3 },
  { id: 'calls_out', label: 'Исходящие звонки', group: 'activity', higherIsBetter: true, format: 'number', tag: 'Звонки', sortOrder: 4 },
  { id: 'repeat_share', label: 'Доля повторных', group: 'repeat', higherIsBetter: true, format: 'percent', tag: 'Повторка', sortOrder: 5 },
];

const P = (id: number, name: string): TaskerPerson => ({ id, name });
const ROPS = [P(501, 'Смирнова Анна Викторовна'), P(502, 'Кузнецов Олег Петрович')];
const MANAGERS = [
  P(1101, 'Иванов Сергей Андреевич'), P(1102, 'Петрова Мария Олеговна'), P(1103, 'Сидоров Алексей Игоревич'),
  P(1104, 'Морозова Елена Сергеевна'), P(1105, 'Волков Дмитрий Николаевич'), P(1106, 'Лебедева Ольга Юрьевна'),
];
const DIRECTOR = P(400, 'Осипов Игорь Владимирович');

const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+03:00`).toISOString();

function task(i: number, status: TaskerStatus, opts: { day: string; hm?: string; slot?: boolean; control?: string; verdict?: TaskerVerdict; session?: number | null }): TaskerTask {
  const m = MOCK_METRICS[i % MOCK_METRICS.length];
  const man = MANAGERS[i % MANAGERS.length];
  const rop = ROPS[i % 2];
  const base = m.format === 'percent' ? 18 : m.format === 'money' ? 64000 : 140;
  const value = Math.round(base * (0.7 + (i % 3) * 0.05) * 10) / 10;
  const deptAvg = base;
  const slotStart = opts.slot ? at(opts.day, opts.hm ?? '11:00') : null;
  return {
    id: 7000 + i,
    bitrixTaskId: i % 5 === 4 ? null : 310000 + i,
    bitrixUrl: i % 5 === 4 ? null : `https://example.bitrix24.ru/company/personal/user/${man.id}/tasks/task/view/${310000 + i}/`,
    syncState: i % 5 === 4 ? 'failed' : 'synced',
    syncError: i % 5 === 4 ? 'Битрикс: не задан проект Задачника' : null,
    title: `Подтянуть «${m.label}» до среднего отдела`,
    body: 'Разобрать 5 последних проигранных сделок на сессии.\nПерезвонить клиентам без КП в течение 2 дней.\nСверить скрипт презентации с эталоном отдела.',
    manager: man, rop, director: DIRECTOR, creator: rop,
    departmentName: i % 2 ? 'Отдел продаж Юг' : 'Отдел продаж Центр',
    metricId: m.id, metricLabel: m.label, metricGroup: m.group, higherIsBetter: m.higherIsBetter, format: m.format,
    period: { from: addDays(todayMsk(), -40), to: addDays(todayMsk(), -10) },
    snapshot: { value, deptAvg, ownAvg6m: Math.round(base * 0.85 * 10) / 10, deptName: i % 2 ? 'Отдел продаж Юг' : 'Отдел продаж Центр', enoughData: i % 7 !== 6, denominator: i % 7 === 6 ? 3 : 24 },
    target: deptAvg,
    templateId: null,
    deadline: at(opts.day, '18:00'),
    durationMin: 30,
    slotStart,
    slotEnd: slotStart ? new Date(new Date(slotStart).getTime() + 30 * 60_000).toISOString() : null,
    controlDate: opts.control ?? addDays(opts.day, 14),
    status,
    bitrixStatus: null,
    closedAt: status === 'done' || status === 'measuring' || status === 'result' ? at(addDays(opts.day, -1), '17:00') : null,
    // Поля правок 23.11 (сессия A) — пока вне TaskerTask, см. taskExtras() в format.ts.
    ...({
      kind: i % 2 ? 'theory' : 'practice',
      assignee: i % 2 ? P(900, 'Будковский Павел') : ROPS[i % 2],
      doneNote: status === 'done' || status === 'measuring' || status === 'result'
        ? 'Разобрали 14 сделок в «Созвонился и озвучил», 6 вывели дальше; проверили брони на неделю.' : null,
      doneAt: status === 'done' || status === 'measuring' || status === 'result' ? at(addDays(opts.day, -1), '17:00') : null,
    } as object),
    verdict: opts.verdict ?? null,
    measuredValue: opts.verdict ? Math.round(value * (opts.verdict === 'achieved' ? 1.35 : opts.verdict === 'improved' ? 1.15 : 1) * 10) / 10 : null,
    measuredAt: opts.verdict ? at(opts.control ?? opts.day, '09:00') : null,
    sessionId: opts.session ?? null,
    trainingEventId: null,
    checklist: i % 3 === 0 ? [
      { clientKey: 'c1', title: 'ООО «Строймонтаж»', crmUrl: 'https://example.bitrix24.ru/crm/company/details/1/', done: true },
      { clientKey: 'c2', title: 'ИП Кравцов А. В.', crmUrl: null, done: false },
    ] : [],
    createdAt: at(addDays(opts.day, -3), '10:00'),
  };
}

export function mockTasks(): TaskerTasksResponse {
  const today = todayMsk();
  const mon = mondayOf(today);
  const tasks: TaskerTask[] = [
    task(0, 'new', { day: today, slot: true, hm: '11:00', session: 1 }),
    task(15, 'new', { day: today, slot: true, hm: '11:00', session: 1 }),
    task(1, 'in_progress', { day: addDays(today, -2) }),
    task(2, 'in_progress', { day: addDays(mon, 3), slot: true, hm: '15:00' }),
    task(3, 'in_progress', { day: today }),
    task(12, 'result', { day: addDays(today, -19), control: addDays(today, -5), verdict: 'improved' }),
    task(4, 'new', { day: addDays(mon, 4) }),
    task(5, 'done', { day: addDays(today, -1) }),
    task(7, 'measuring', { day: addDays(today, -14), control: today }),
    task(8, 'measuring', { day: addDays(today, -5), control: addDays(today, 9) }),
    task(9, 'result', { day: addDays(today, -20), control: addDays(today, -6), verdict: 'achieved' }),
    task(10, 'result', { day: addDays(today, -21), control: addDays(today, -7), verdict: 'no_change' }),
    task(13, 'result', { day: addDays(today, -21), control: addDays(today, -7), verdict: 'not_enough_data' }),
    task(11, 'new', { day: addDays(mon, 1), slot: true, hm: '10:00' }),
  ];
  const s1 = tasks.filter(t => t.sessionId === 1);
  const sessions: TaskerSession[] = [{
    id: 1, rop: ROPS[0], metricId: s1[0].metricId, metricLabel: s1[0].metricLabel,
    slotStart: at(today, '11:00'), durationMin: 30 + 15 * (s1.length - 1), calendarEventId: null,
    taskIds: s1.map(t => t.id), managers: s1.map(t => t.manager),
  }];
  const trainings: TrainingEnrollment[] = [
    { eventId: 31, title: 'Работа с возражениями «дорого»', startsAt: at(addDays(mon, 2), '14:00'), durationMin: 90, place: 'Переговорная 3', trainer: P(900, 'Будковский Павел'), manager: MANAGERS[1] },
    { eventId: 32, title: 'Скрипт повторной продажи', startsAt: at(today, '16:00'), durationMin: 60, place: 'Zoom', trainer: P(900, 'Будковский Павел'), manager: MANAGERS[0] },
  ];
  return { tasks, sessions, trainings };
}
