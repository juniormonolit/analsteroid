// Заказчик задачи больших чеков — для вкладки «Звонки» и расшифровки по кнопке. Директор по продажам Осипов
// (19.11, скриншот «Звонки видят только РОПы»): звонки по задаче должен видеть каждый, кто видит саму задачу,
// а не только владельцы права action.ai_call_analysis (оно — для ИИ-анализа карточки клиента). Поэтому
// заказчика берём НЕ из запроса, а из сделки задачи: по чужому id клиента звонки отсюда не прочитать.
import type { SessionUser as Session } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { bx } from '@/lib/bitrix/notify';
import type { ClientRef } from '@/features/client-module/engine/types';
import { bigActor } from './actor';
import { BigActionError, fetchBigTask, taskPeople } from './actions';
import { BIG_DEALS_GROUP_IDS } from './config';
import { canSeeTask } from './visibility';
import { crmReadWebhook } from './rest';

/** Задача видна сессии → заказчик её сделки (компания, иначе контакт); null — у сделки нет заказчика. */
export async function taskClientRef(session: Session, taskId: number): Promise<ClientRef | null> {
  if (!hasPerm(session, 'section.repeat_kanban')) throw new BigActionError('Нет доступа к канбану', 403);
  if (!Number.isInteger(taskId) || taskId <= 0) throw new BigActionError('Некорректная задача', 400);
  const t = await fetchBigTask(taskId);
  if (!t) throw new BigActionError('Задача не найдена в Битриксе', 404);
  if (!BIG_DEALS_GROUP_IDS.includes(Number(t.groupId))) throw new BigActionError('Задача не из проектов больших сделок', 403);
  if (!canSeeTask(await taskPeople(t), await bigActor(session))) throw new BigActionError('Задача не в вашей зоне', 403);
  const dealId = Number((t.ufCrmTask ?? []).map(String).find(x => /^D_\d+$/.test(x))?.slice(2)) || 0;
  if (!dealId) return null;
  const r = await (bx(crmReadWebhook(), 'crm.deal.get', { id: dealId }) as Promise<{ result?: { COMPANY_ID?: string | null; CONTACT_ID?: string | null } }>)
    .catch(() => { throw new BigActionError('Битрикс не отдал сделку', 502); });
  const company = Number(r.result?.COMPANY_ID) || 0;
  const contact = Number(r.result?.CONTACT_ID) || 0;
  return company ? `k${company}` : contact ? `c${contact}` : null;
}
