// «Большой брат» → «Люди»: подписи и форматирование (клиент).

const TZ = 'Europe/Moscow';

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

export function fmtMin(m: number): string {
  if (!m) return '0';
  return m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}` : `${m} мин`;
}

export function fmtDateLong(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

export function todayMsk(): string {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}

export function shiftDate(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Минуты от начала дня МСК. */
export function mskMinuteOfDay(iso: string): number {
  const d = new Date(Date.parse(iso) + 3 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export const sumCounts = (c: Record<string, number> | undefined, keys: string[]) => keys.reduce((s, k) => s + (c?.[k] ?? 0), 0);
export const callsOf = (c?: Record<string, number>) => sumCounts(c, ['call.out_reached', 'call.out_attempt', 'call.in']);
export const dealsOf = (c?: Record<string, number>) => sumCounts(c, ['deal_stage', 'deal_new']);
export const tasksOf = (c?: Record<string, number>) => sumCounts(c, ['task.create', 'task.close']);
export const servicesOf = (c?: Record<string, number>) => sumCounts(c, ['mono_action', 'kanban', 'logist']);

const CALL: Record<string, string> = {
  out_reached: 'исходящий, дозвон', out_attempt: 'исходящий, без дозвона', in: 'входящий', in_missed: 'пропущенный входящий',
};
const TASK: Record<string, string> = {
  create: 'поставил задачу', close: 'закрыл задачу', touch: 'изменение задачи (без автора)',
};
const MONO: Record<string, string> = {
  task_create: 'поставил задачу', task_update: 'изменил задачу', task_reschedule: 'перенёс срок', task_close: 'закрыл / принял задачу',
  task_return: 'вернул на доработку', task_delete: 'удалил задачу', task_comment: 'комментарий', deal_move: 'перенёс карточку',
  deal_update: 'изменил сделку', request_create: 'создал запрос', request_update: 'изменил запрос', request_assign: 'взял / назначил запрос',
  settings_update: 'настройки', other: 'действие', login: 'вход', logout: 'выход',
};
const KANBAN: Record<string, string> = {
  deal_task_created: 'поставил задачу', task_created: 'поставил задачу', task_replaced: 'заменил задачу', task_returned: 'вернул задачу',
  task_accepted: 'принял задачу', task_accepted_deal_closed: 'принял, сделка закрыта', task_accepted_postponed: 'принял, отложено',
  task_rescheduled: 'перенёс срок', task_comment_posted: 'комментарий', queue_added: 'добавил в очередь', queue_removed: 'убрал из очереди',
  manager_reassigned: 'переназначил менеджера', reject_reviewed: 'разобрал отказ', deal_returned_from_reject: 'вернул из отказа',
  rejected_direct: 'отказ', hidden: 'скрыл',
};

/** Человеческая подпись события ленты. */
export function eventLabel(kind: string, action: string | null): string {
  switch (kind) {
    case 'call': return `Звонок: ${CALL[action ?? ''] ?? action ?? ''}`;
    case 'deal_stage': return 'Смена стадии сделки';
    case 'deal_new': return 'Новая сделка';
    case 'task': return `Задача: ${TASK[action ?? ''] ?? action ?? ''}`;
    case 'mono_view': return `Монолитика: открыл «${action ?? '—'}»`;
    case 'mono_minute': return `Монолитика: активен${action ? ` («${action}»)` : ''}`;
    case 'mono_action': return `Монолитика: ${MONO[action ?? ''] ?? action ?? 'действие'}`;
    case 'session': return `Монолитика: ${MONO[action ?? ''] ?? action ?? 'сессия'}`;
    case 'kanban': return `Канбан повторки: ${KANBAN[action ?? ''] ?? action ?? ''}`;
    case 'logist': return `Канбан логиста: ${action ?? ''}`;
    default: return `${kind}${action ? `: ${action}` : ''}`;
  }
}

export const CARD = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]';
