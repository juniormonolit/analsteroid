// Видимость и право управлять задачей «Канбана больших чеков» — ОДНА функция для доски, карточки задачи,
// действий и массового закрытия (аудит 18.11: доска показывала карточку по ответственному сделки, а действие
// отвечало 403). Зона — иерархия: ropScope → scopeManagers (bigActor в actor.ts); менеджер — только свои.
import type { BigTaskCard } from './types';

/** Минимум про пользователя (BigActor из actions.ts подходит структурно). zone: 'all' — руководство без ограничений. */
export interface VisibilityActor {
  userId: string | null;
  canManage: boolean;
  zone: Set<string> | 'all';
}

/** Люди задачи. Можно передать карточку доски или сырые поля задачи Битрикса (+ ответственный сделки). */
export interface TaskPeople {
  responsibleId: string | number | null | undefined;
  createdBy: string | number | null | undefined;
  auditors?: (string | number)[] | null;
  accomplices?: (string | number)[] | null;
  /** ASSIGNED_BY_ID сделки — у карточки берётся из card.deal.assigned. Без него видимость у́же, чем на доске. */
  dealAssignedId?: string | number | null;
}

const isCard = (x: BigTaskCard | TaskPeople): x is BigTaskCard => 'responsible' in x && typeof (x as BigTaskCard).responsible === 'object';

export function peopleOf(x: BigTaskCard | TaskPeople): Required<{ [K in keyof TaskPeople]: string[] }> {
  const s = (v: string | number | null | undefined) => (v === null || v === undefined || String(v) === '' || String(v) === '0' ? [] : [String(v)]);
  if (isCard(x)) {
    return {
      responsibleId: s(x.responsible.id), createdBy: s(x.creator.id), auditors: x.auditors.map(String),
      accomplices: [], dealAssignedId: s(x.deal?.assigned?.id),
    };
  }
  return {
    responsibleId: s(x.responsibleId), createdBy: s(x.createdBy),
    auditors: (x.auditors ?? []).map(String), accomplices: (x.accomplices ?? []).map(String), dealAssignedId: s(x.dealAssignedId),
  };
}

/** Видит задачу: полная зона; или сам участник (исполнитель/постановщик/наблюдатель/соисполнитель/ответственный
 *  сделки); или исполнитель, постановщик или ответственный сделки — из зоны. */
export function canSeeTask(x: BigTaskCard | TaskPeople, actor: VisibilityActor): boolean {
  if (actor.zone === 'all') return true;
  const p = peopleOf(x);
  const me = actor.userId;
  if (me && [...p.responsibleId, ...p.createdBy, ...p.auditors, ...p.accomplices, ...p.dealAssignedId].includes(me)) return true;
  const zone = actor.zone;
  return [...p.responsibleId, ...p.createdBy, ...p.dealAssignedId].some(id => zone.has(id));
}

/** Может двигать/переназначать/закрывать: роль управления (canManage) и задача его зоны — исполнитель, постановщик
 *  или ответственный сделки в зоне (одного участия наблюдателем мало). */
export function canManageTask(x: BigTaskCard | TaskPeople, actor: VisibilityActor): boolean {
  if (!actor.canManage) return false;
  if (actor.zone === 'all') return true;
  const p = peopleOf(x);
  const zone = actor.zone;
  return [...p.responsibleId, ...p.createdBy, ...p.dealAssignedId].some(id => zone.has(id));
}
