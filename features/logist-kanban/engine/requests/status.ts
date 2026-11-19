// Переходы статусов и «кто может» — чистые функции, без БД. Одна точка правды для API (проверка)
// и UI (кнопки рисуются по RequestDetails.can, который считает canDo()).
import type { ActionKind, RequestRoles, RequestStatus } from './contract';

/** Кто нажимает: всё, что нужно для решений о правах, уже посчитано (engine/requests/actor.ts). */
export interface ActorCtx {
  bitrixId: string | null;
  login: string;
  /** canManageLogistKanban: руководитель логистики / админ — всё */
  canManage: boolean;
  /** очереди, где пользователь участник / руководитель */
  queueIds: ReadonlySet<number>;
  leadQueueIds: ReadonlySet<number>;
  /** менеджеры зоны РОПа (bitrix id); 'all' — вся компания; пусто — не РОП */
  zone: ReadonlySet<string> | 'all';
}

/** Минимум о запросе для решений. */
export interface RequestPeople {
  status: RequestStatus;
  managerBitrixId: string;
  createdByLogin: string | null;
  logistBitrixId: string | null;
  queueId: number | null;
}

export function rolesOf(a: ActorCtx, r: RequestPeople): RequestRoles {
  const me = a.bitrixId;
  const manager = (!!me && r.managerBitrixId === me) || (!!r.createdByLogin && r.createdByLogin === a.login);
  const inZone = a.zone === 'all' || a.zone.has(r.managerBitrixId);
  return {
    manager,
    logist: !!me && r.logistBitrixId === me,
    queueMember: r.queueId !== null && a.queueIds.has(r.queueId),
    queueLead: r.queueId !== null && a.leadQueueIds.has(r.queueId),
    rop: inZone && !manager,
    admin: a.canManage,
  };
}

/** Видимость: черновик — только автору и админу; остальное — менеджеру, логисту, очереди, РОПу зоны, админу. */
export function canSee(a: ActorCtx, r: RequestPeople): boolean {
  const ro = rolesOf(a, r);
  if (ro.admin || ro.manager) return true;
  if (r.status === 'draft') return false;
  return ro.logist || ro.queueMember || ro.rop;
}

/** Целевой статус действия; null — действие не меняет статус. */
export const NEXT_STATUS: Record<ActionKind, (from: RequestStatus) => RequestStatus | null> = {
  update_draft: () => null,
  send: () => 'new',
  take: () => 'in_work',
  release: () => 'new',
  transfer: () => 'new',
  // переназначение на конкретного логиста: запрос сразу «в работе» у него
  reassign: (from) => (from === 'answered' ? null : 'in_work'),
  // ответ из «Новых» — логист очереди сразу отвечает (взятие засчитывается тем же моментом)
  answer: () => 'answered',
  withdraw_offer: () => null,
  return: () => 'in_work',
  accept: () => 'accepted',
  cancel: () => 'cancelled',
  add_items: () => null,
};

/** Из каких статусов действие допустимо. */
export const FROM_STATUSES: Record<ActionKind, readonly RequestStatus[]> = {
  update_draft: ['draft'],
  send: ['draft'],
  take: ['new'],
  release: ['in_work'],
  transfer: ['new', 'in_work'],
  reassign: ['new', 'in_work', 'answered'],
  answer: ['new', 'in_work', 'answered'],
  withdraw_offer: ['answered', 'in_work'],
  return: ['answered'],
  accept: ['answered'],
  cancel: ['draft', 'new', 'in_work', 'answered'],
  add_items: ['draft', 'new', 'in_work', 'answered'],
};

/** Кто может (без учёта статуса). */
function allowedBy(action: ActionKind, ro: RequestRoles, r: RequestPeople): boolean {
  if (ro.admin) return true;
  switch (action) {
    case 'update_draft': case 'send': case 'return': case 'accept': case 'add_items':
      return ro.manager;
    case 'cancel':
      return ro.manager || ro.rop;
    case 'take':
      return ro.queueMember || ro.queueLead;
    case 'release':
      return ro.logist || ro.queueLead;
    case 'transfer':
      // логист очереди (взятый или свободный) или держатель
      return ro.logist || ro.queueLead || (ro.queueMember && !r.logistBitrixId);
    case 'reassign':
      return ro.queueLead || ro.rop;
    case 'answer':
      return ro.logist || ro.queueLead || (ro.queueMember && !r.logistBitrixId);
    case 'withdraw_offer':
      return ro.logist || ro.queueLead;
  }
}

export interface Decision { ok: boolean; reason?: string; code?: 'forbidden' | 'transition' }

/** Можно ли actor выполнить action над запросом r сейчас. */
export function canDo(a: ActorCtx, r: RequestPeople, action: ActionKind): Decision {
  if (!FROM_STATUSES[action].includes(r.status)) {
    return { ok: false, code: 'transition', reason: `Действие недоступно в статусе «${r.status}»` };
  }
  const ro = rolesOf(a, r);
  if (!allowedBy(action, ro, r)) return { ok: false, code: 'forbidden', reason: 'Недостаточно прав для этого действия' };
  return { ok: true };
}

/** Писать в чат: все, кто видит запрос; в черновике — только автор/админ. */
export function canMessage(a: ActorCtx, r: RequestPeople): boolean {
  return canSee(a, r);
}

export function allowedActions(a: ActorCtx, r: RequestPeople): Record<ActionKind, boolean> & { message: boolean } {
  const out = { message: canMessage(a, r) } as Record<ActionKind, boolean> & { message: boolean };
  for (const k of Object.keys(FROM_STATUSES) as ActionKind[]) out[k] = canDo(a, r, k).ok;
  return out;
}
