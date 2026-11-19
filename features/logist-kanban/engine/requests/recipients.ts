// S5: кому из участников очереди слать «новый запрос» / «горит SLA». Состав очереди = участники проекта Битрикса
// (решение владельца 19.11), а там кроме логистов CEO, COO, РОПы, разработчики, служебные аккаунты. Видимость и
// «Взять» этот фильтр не трогает — только рассылку. Чистые функции (тест — scripts/assert-logist-requests.ts).
import type { NotifyRecipientsSettings, QueueMember } from './contract';

export type RecipientVerdict = 'include' | 'exclude' | 'position' | 'no_position' | 'other_position';

/** Почему участник получает / не получает уведомления (для экрана настроек и следа решения бота). */
export function recipientVerdict(m: Pick<QueueMember, 'bitrixId' | 'workPosition'>, s: NotifyRecipientsSettings): RecipientVerdict {
  if (s.includeBitrixIds.includes(m.bitrixId)) return 'include';
  if (s.excludeBitrixIds.includes(m.bitrixId)) return 'exclude';
  if (!s.positionPatterns.length) return 'position';
  const pos = (m.workPosition ?? '').toLowerCase();
  if (!pos) return 'no_position';
  return s.positionPatterns.some(p => pos.includes(p)) ? 'position' : 'other_position';
}

export const isRecipient = (v: RecipientVerdict) => v === 'include' || v === 'position';

export const VERDICT_LABEL: Record<RecipientVerdict, string> = {
  include: 'включён вручную',
  exclude: 'исключён вручную',
  position: 'по должности',
  no_position: 'должность не указана',
  other_position: 'не логист по должности',
};

/** Получатели очереди: логисты (без lead-фильтра — руководитель очереди тоже логист), без дублей и без exceptId. */
export function queueRecipients(members: readonly QueueMember[], s: NotifyRecipientsSettings, exceptId?: string | null): string[] {
  const out = new Set<string>();
  for (const m of members) if (m.bitrixId !== exceptId && isRecipient(recipientVerdict(m, s))) out.add(m.bitrixId);
  return [...out];
}
