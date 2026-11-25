// «Большой брат» → «Сторож» МОПов: клиент-безопасные типы/константы/валидация (без pg).
// Импортируют и страница настроек, и API (app/api/big-brother/watch/*), и движок lib/bots/idleWatch.ts.

export const IDLE_WATCH_RECIPIENTS = ['manager', 'rop', 'department_director', 'company_director', 'fixed'] as const;
export type IdleWatchRecipient = (typeof IDLE_WATCH_RECIPIENTS)[number];

export const RECIPIENT_LABELS: Record<IdleWatchRecipient, string> = {
  manager: 'Менеджеру',
  rop: 'РОПу',
  department_director: 'Директору отдела',
  company_director: 'Директору компании',
  fixed: 'Конкретному сотруднику (Bitrix ID)',
};

/** Плейсхолдеры шаблона — подсказка в редакторе и контракт рендера движка. */
export const TEMPLATE_PLACEHOLDERS: Array<{ key: string; hint: string }> = [
  { key: 'manager_name', hint: 'ФИО менеджера (руководителю — ссылкой на чат с ним)' },
  { key: 'department', hint: 'отдел менеджера' },
  { key: 'rop_name', hint: 'РОП менеджера' },
  { key: 'hours', hint: '«2 ч 15 мин»' },
  { key: 'minutes', hint: 'минут тишины числом' },
  { key: 'since', hint: 'с какого времени тишина, «11:40»' },
  { key: 'last_signal', hint: 'последний сигнал: «звонок в 11:40» / «до начала окна»' },
  { key: 'recipient_name', hint: 'кому сообщение' },
];

export interface IdleWatchSettingsDto {
  enabled: boolean;
  dryRun: boolean;
  windowStartHour: number;
  windowEndHour: number;
  mirrorBitrixUserId: string;
  lastTickAt: string | null;
  lastTickSummary: string | null;
}

export interface IdleWatchRuleDto {
  id: number;
  sortOrder: number;
  name: string;
  minutesIdle: number;
  recipient: IdleWatchRecipient;
  fixedBitrixUserId: string | null;
  template: string;
  isActive: boolean;
}

export interface IdleWatchDeliveryDto {
  id: number;
  sentAt: string;
  managerName: string | null;
  managerBitrixUserId: string;
  silenceFrom: string;
  minutesIdle: number;
  ruleName: string | null;
  recipientKind: string;
  recipientName: string | null;
  message: string;
  dryRun: boolean;
  mirrored: boolean;
  error: string | null;
}

/** Итог прогона «что было бы» по дню (dry-run на истории). */
export interface IdleWatchSimulationDto {
  date: string;
  workingDay: boolean;
  watched: number;          // МОПов под наблюдением
  inWork: number;           // из них «в работе» в этот день
  cases: number;            // окон тишины ≥ минимального порога
  managersWithCases: number;
  byRule: Array<{ ruleId: number; name: string; minutesIdle: number; recipient: string; fired: number }>;
  sourceRows: Record<string, number>;
  top: Array<{ managerName: string; bitrixId: string; cases: number; maxMinutes: number }>;
}

export interface RuleBody {
  name?: string;
  sortOrder?: number;
  minutesIdle?: number;
  recipient?: IdleWatchRecipient;
  fixedBitrixUserId?: string | null;
  template?: string;
  isActive?: boolean;
}

export function validateRule(b: RuleBody, creating: boolean): string | null {
  if (creating && (b.minutesIdle == null || b.recipient == null)) return 'нужны порог и получатель';
  if (b.minutesIdle != null && (!Number.isInteger(b.minutesIdle) || b.minutesIdle < 15 || b.minutesIdle > 720)) {
    return 'порог — целое число минут от 15 до 720';
  }
  if (b.recipient !== undefined && !IDLE_WATCH_RECIPIENTS.includes(b.recipient)) return 'получатель невалиден';
  if (b.fixedBitrixUserId != null && b.fixedBitrixUserId.trim() && !/^\d+$/.test(b.fixedBitrixUserId.trim())) return 'Bitrix ID — число';
  if (b.template != null && b.template.length > 2000) return 'шаблон длиннее 2000 символов';
  if (b.name != null && b.name.length > 200) return 'название длиннее 200 символов';
  return null;
}

/** «135» → «2 ч 15 мин». */
export function formatIdle(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
