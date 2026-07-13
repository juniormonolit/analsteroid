// Клиент-безопасные хелперы/константы бота «Контроль звонков» (без pg/fs — модуль
// импортируется и клиентскими страницами) + валидация тел запросов админки
// (вынесена из route.ts: Next разрешает экспортировать из роутов только хендлеры).

export const DEAL_URL_PREFIX = 'https://td.monolit-crm.ru/crm/deal/details/';

export const CALL_CONTROL_RECIPIENTS = ['manager', 'rop', 'department_director', 'company_director', 'fixed'] as const;
export type CallControlRecipient = (typeof CALL_CONTROL_RECIPIENTS)[number];

export interface RuleBody {
  name?: string;
  sortOrder?: number;
  missedCountGte?: number | null;
  minutesWithoutCallback?: number | null;
  operator?: 'and' | 'or';
  recipient?: CallControlRecipient;
  fixedBitrixUserId?: string | null;
  templateId?: number | null;
  isActive?: boolean;
}

export function validateRule(b: RuleBody): string | null {
  if (b.operator !== undefined && b.operator !== 'and' && b.operator !== 'or') return 'operator: and|or';
  if (b.recipient !== undefined && !CALL_CONTROL_RECIPIENTS.includes(b.recipient)) return 'recipient невалиден';
  // «fixed» без ID не блокируем: UI сначала переключает тип, потом даёт ввести ID;
  // движок для такого правила честно запишет в доставку «получатель не разрешился».
  if (b.fixedBitrixUserId != null && b.fixedBitrixUserId.trim() && !/^\d+$/.test(b.fixedBitrixUserId.trim())) return 'Bitrix ID — число';
  for (const [k, v] of [['missedCountGte', b.missedCountGte], ['minutesWithoutCallback', b.minutesWithoutCallback]] as const) {
    if (v != null && (!Number.isInteger(v) || v < 0 || v > 100000)) return `${k}: целое ≥ 0`;
  }
  if (b.sortOrder != null && !Number.isInteger(b.sortOrder)) return 'sortOrder: целое';
  if (b.templateId != null && !Number.isInteger(b.templateId)) return 'templateId: целое';
  return null;
}

// «2ч 05м» для отчёта/топа безответственных (чистая, используется и в client-коде).
export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

export interface TemplateBody {
  name?: string;
  body?: string;
}

export function validateTemplate(b: TemplateBody, requireAll: boolean): string | null {
  if (requireAll && (!b.name?.trim() || !b.body?.trim())) return 'нужны name и body';
  if (b.name !== undefined && !b.name.trim()) return 'пустое имя';
  if (b.body !== undefined && !b.body.trim()) return 'пустой текст шаблона';
  if ((b.body ?? '').length > 4000) return 'шаблон длиннее 4000 символов';
  return null;
}
