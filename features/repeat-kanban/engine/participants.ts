// Участники задачи канбана повторных (владелец 23.10: «при постановке задачи — опция сразу добавить соисполнителем/
// наблюдателем + поиск с множественным выбором; по умолчанию — соисполнителем РОП менеджера»). Общий для сервера и
// клиента (без БД). ROP_TOKEN — «РОП ответственного менеджера», разворачивается сервером в момент постановки/выдачи.
export interface TaskParticipants { accomplices: string[]; auditors: string[] }
export const ROP_TOKEN = '__rop';
export const DEFAULT_PARTICIPANTS: TaskParticipants = { accomplices: [ROP_TOKEN], auditors: [] };
const MAX = 20;

/** Из тела запроса: только числовые Битрикс-id и ROP_TOKEN, без повторов; один человек — в одной роли (соисполнитель важнее). */
export function normalizeParticipants(raw: unknown): TaskParticipants | null {
  if (!raw || typeof raw !== 'object') return null;
  const list = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(String).filter(x => x === ROP_TOKEN || /^\d{1,10}$/.test(x)))].slice(0, MAX);
  const accomplices = list((raw as TaskParticipants).accomplices);
  const auditors = list((raw as TaskParticipants).auditors).filter(x => !accomplices.includes(x));
  return accomplices.length || auditors.length ? { accomplices, auditors } : null;
}
