// Кто из участников проекта Битрикса — «логист очереди» (решение владельца 19.11, подтверждено после S5): тот, у кого
// в должности (work_position) есть «логист» или «снабж» — без учёта регистра, ё = е; плюс ручные «включить / исключить»
// в настройках (пустая или нестандартная должность). Остальные участники проекта (CEO, COO, РОПы, разработчики,
// админ-аккаунты) логистами очереди НЕ считаются: не видят запросы очереди как логисты, не берут их, не получают
// «новый запрос» / «горит SLA». ОДНО правило для прав движка (actor.ts → queueIds) и для рассылки (notify.ts).
// Настройки — LogistSettings.notify (имя поля историческое: появилось как фильтр рассылки). Чистые функции
// (тест — scripts/assert-logist-requests.ts).
import type { NotifyRecipientsSettings, QueueMember } from './contract';

export type RecipientVerdict = 'include' | 'exclude' | 'position' | 'no_position' | 'other_position';

/** Почему участник получает / не получает уведомления (для экрана настроек и следа решения бота). */
export function recipientVerdict(m: Pick<QueueMember, 'bitrixId' | 'workPosition'>, s: NotifyRecipientsSettings): RecipientVerdict {
  if (s.includeBitrixIds.includes(m.bitrixId)) return 'include';
  if (s.excludeBitrixIds.includes(m.bitrixId)) return 'exclude';
  if (!s.positionPatterns.length) return 'position';
  const pos = normPosition(m.workPosition);
  if (!pos) return 'no_position';
  return s.positionPatterns.some(p => pos.includes(normPosition(p))) ? 'position' : 'other_position';
}

/** Должность для сравнения: нижний регистр, ё → е, пробелы схлопнуты. */
export const normPosition = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Логист очереди: руководитель очереди (role lead — назначается вручную) или участник, прошедший правило. */
export const isQueueLogist = (m: Pick<QueueMember, 'bitrixId' | 'workPosition'> & { role?: QueueMember['role'] }, s: NotifyRecipientsSettings) =>
  m.role === 'lead' || isRecipient(recipientVerdict(m, s));

export const isRecipient = (v: RecipientVerdict) => v === 'include' || v === 'position';

export const VERDICT_LABEL: Record<RecipientVerdict, string> = {
  include: 'логист — включён вручную',
  exclude: 'не логист — исключён вручную',
  position: 'логист по должности',
  no_position: 'не логист — должность не указана',
  other_position: 'не логист по должности',
};

/** Получатели очереди: логисты (без lead-фильтра — руководитель очереди тоже логист), без дублей и без exceptId. */
export function queueRecipients(members: readonly QueueMember[], s: NotifyRecipientsSettings, exceptId?: string | null): string[] {
  const out = new Set<string>();
  for (const m of members) if (m.bitrixId !== exceptId && isQueueLogist(m, s)) out.add(m.bitrixId);
  return [...out];
}
