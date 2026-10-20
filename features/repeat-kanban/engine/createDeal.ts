// Кнопка «Сделка + задача»: повторная сделка в Битриксе так, как её создаёт менеджер
// ИЗ КОНТАКТА (контакт → «Сделки» → создать). Разбор 100 последних повторных сделок
// 20.10: при таком создании Битрикс переносит из контакта ответственного, источник
// (и его описание), компанию; ставит «Доступна для всех», тип «Продажа», рубли,
// реквизиты нашей компании; название пустое → «Сделка #ID». Анкетные поля не
// переносятся. КОПИЮ прошлой сделки не делаем — она тащит старые отметки времени.
// Если последняя повторная сделка в отказе — не создаём новую, а откатываем её (владелец 20.10).
import { bx } from '@/lib/bitrix/notify';
import { NEW_DEAL_STAGE } from './config';

export class DealCreateError extends Error {}

function webhook(): string {
  // Тот же вебхук записи сделок, что у «Разгрузки отделов» (crm.deal.update), фолбэк — основной.
  const w = process.env.BITRIX_WEBHOOK_URL_2 || process.env.BITRIX_WEBHOOK_URL || '';
  if (!w) throw new DealCreateError('Не задан вебхук Битрикса — создать сделку невозможно');
  return w.replace(/\/+$/, '');
}

async function read<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const body = await bx(webhook(), method, params) as { result: T };
  return body.result;
}

/** Без автоповтора: повтор после таймаута мог бы завести вторую сделку. */
async function addOnce(fields: Record<string, unknown>): Promise<number> {
  let res: Response;
  try {
    res = await fetch(`${webhook()}/crm.deal.add.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, params: { REGISTER_SONET_EVENT: 'Y' } }), signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new DealCreateError(`Битрикс crm.deal.add: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await res.json().catch(() => null) as { result?: number; error?: string; error_description?: string } | null;
  if (!res.ok || !body || body.error || !body.result) {
    throw new DealCreateError(`Битрикс crm.deal.add: ${body?.error ?? `HTTP ${res.status}`} ${body?.error_description ?? ''}`.trim());
  }
  return Number(body.result);
}

interface BxEntity { ID: string; ASSIGNED_BY_ID?: string; SOURCE_ID?: string | null; SOURCE_DESCRIPTION?: string | null; COMPANY_ID?: string | null }
interface BxDeal { ID: string; MYCOMPANY_ID?: string | null; STAGE_ID?: string; STAGE_SEMANTIC_ID?: string; CATEGORY_ID?: string }

/** Ключ заказчика → воронка и сущность. 'c' — физлицо (B2C, воронка 2); 'k' — компания и
 *  'x' (юр-сделка без карточки компании, физически контакт) — B2B, воронка 3. */
export function dealTargetOf(clientKey: string): { funnel: 2 | 3; entity: 'contact' | 'company'; id: number } {
  const id = Number(clientKey.slice(1));
  if (clientKey.startsWith('k')) return { funnel: 3, entity: 'company', id };
  return { funnel: clientKey.startsWith('x') ? 3 : 2, entity: 'contact', id };
}

/** Стадии «не трогать»: откатывать и заводить новую сделку нельзя (штраф по регламенту). */
const DO_NOT_TOUCH_STAGES = new Set(['C2:2']);

async function updateOnce(id: number, fields: Record<string, unknown>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${webhook()}/crm.deal.update.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, fields, params: { REGISTER_SONET_EVENT: 'Y' } }), signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new DealCreateError(`Битрикс crm.deal.update: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await res.json().catch(() => null) as { result?: boolean; error?: string; error_description?: string } | null;
  if (!res.ok || !body || body.error || !body.result) {
    throw new DealCreateError(`Битрикс crm.deal.update: ${body?.error ?? `HTTP ${res.status}`} ${body?.error_description ?? ''}`.trim());
  }
}

export type RepeatDealMode = 'existing' | 'reopened' | 'created';

/**
 * Сделка под задачу РОПа (правило владельца 20.10): открытая повторная есть — берём её;
 * последняя повторная в ОТКАЗЕ — откатываем её в «Сделка» (C2/C3:NEW) на исполнителя;
 * иначе — новая, как из контакта.
 */
export async function createRepeatDeal(input: { clientKey: string; assignedBitrixId: string }): Promise<{ dealId: number; mode: RepeatDealMode }> {
  const t = dealTargetOf(input.clientKey);
  if (!Number.isInteger(t.id) || t.id <= 0) throw new DealCreateError('Некорректный заказчик');
  const owner = t.entity === 'contact' ? 'CONTACT_ID' : 'COMPANY_ID';

  // Защита от второй сделки: если открытая повторная уже есть (двойной клик, менеджер
  // создал сам минуту назад, синк sa ещё не догнал) — возвращаем её.
  const open = await read<BxDeal[]>('crm.deal.list', {
    filter: { [owner]: t.id, CATEGORY_ID: t.funnel, STAGE_SEMANTIC_ID: 'P' }, select: ['ID'], order: { ID: 'DESC' },
  });
  if (open?.[0]) return { dealId: Number(open[0].ID), mode: 'existing' };

  // Последняя повторная сделка заказчика в этой воронке: в отказе — откатываем её.
  const last = (await read<BxDeal[]>('crm.deal.list', {
    filter: { [owner]: t.id, CATEGORY_ID: t.funnel }, select: ['ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID'], order: { ID: 'DESC' },
  }))?.[0];
  if (last?.STAGE_ID && DO_NOT_TOUCH_STAGES.has(last.STAGE_ID)) {
    throw new DealCreateError(`Сделка #${last.ID} в стадии «НЕ ТРОГАТЬ — ЗАПРЕЩЕНО»: заказчика не трогаем`);
  }
  if (last && last.STAGE_SEMANTIC_ID === 'F') {
    await updateOnce(Number(last.ID), { STAGE_ID: NEW_DEAL_STAGE[t.funnel], ASSIGNED_BY_ID: Number(input.assignedBitrixId) });
    return { dealId: Number(last.ID), mode: 'reopened' };
  }

  const entity = await read<BxEntity>(t.entity === 'contact' ? 'crm.contact.get' : 'crm.company.get', { id: t.id });
  if (!entity?.ID) throw new DealCreateError(`${t.entity === 'contact' ? 'Контакт' : 'Компания'} #${t.id} не найден(а) в Битриксе`);
  // Реквизиты нашей компании — как в прошлой сделке заказчика (при ручном создании они
  // совпадают с прошлой сделкой в 21 из 23 случаев).
  const prev = await read<BxDeal[]>('crm.deal.list', {
    filter: { [owner]: t.id }, select: ['ID', 'MYCOMPANY_ID'], order: { ID: 'DESC' },
  });

  const fields: Record<string, unknown> = {
    CATEGORY_ID: t.funnel,
    STAGE_ID: NEW_DEAL_STAGE[t.funnel],
    [owner]: t.id,
    ASSIGNED_BY_ID: Number(input.assignedBitrixId),
    OPENED: 'Y',
    TYPE_ID: 'SALE',
    CURRENCY_ID: 'RUB',
  };
  if (entity.SOURCE_ID) fields.SOURCE_ID = entity.SOURCE_ID;
  if (entity.SOURCE_DESCRIPTION) fields.SOURCE_DESCRIPTION = entity.SOURCE_DESCRIPTION;
  if (t.entity === 'contact' && entity.COMPANY_ID && Number(entity.COMPANY_ID) > 0) fields.COMPANY_ID = Number(entity.COMPANY_ID);
  const myCompany = prev?.find(d => d.MYCOMPANY_ID && Number(d.MYCOMPANY_ID) > 0)?.MYCOMPANY_ID;
  if (myCompany) fields.MYCOMPANY_ID = Number(myCompany);

  return { dealId: await addOnce(fields), mode: 'created' };
}
