// Какие сделки sa.deals принадлежат клиенту карточки — ОДНО правило для таблицы сделок
// (clientModule.ts), хронологии/истории (history.ts) и проверки «сделка своя» (привязка к объекту).
//
// Контакт (c/x<id>) — все сделки контакта (решение владельца 20.10).
// Компания (k<id>) — сделки компании И юр-сделки (воронки 1/3) её контактов, если у сделки нет
// компании или компания — «спутник». Спутник — компания, у которой ВСЕ сделки заведены на контакты
// этой компании (пустая карточка «Без названия», которую менеджер создал при выставлении счёта).
// Живой случай 18.11, «М-класс» k41808: бронь #274592 заведена на контакт компании 287391 и пустую
// компанию 44944 «Без названия» (создана тем же менеджером через час после сделки). Доска повторных
// (repeat-kanban/engine/board.ts fetchLatestRepeatDeals) берёт сделки контактов компании и показывала
// «Бронь · Сделка #274592», а карточка клиента — нет: ни в таблице, ни в хронологии, «В работе 0».
// Сделки настоящей ДРУГОЙ компании (у неё есть сделки на чужие контакты) в карточку не попадают:
// человек бывает закупщиком у нескольких фирм, их покупки — не история этого заказчика.
import type { ClientRef } from './types';

/** Контакты компании — встречавшиеся в её сделках (как contactsOf у доски повторных). */
const companyContacts = (p: string) =>
  `SELECT cc.contact_id FROM sa.deals cc WHERE cc.company_id = ${p} AND coalesce(cc.contact_id, 0) <> 0 AND cc.funnel_id IN (0,1,2,3)`;

/** SQL-условие «сделка `d` принадлежит клиенту ref»; `p` — плейсхолдер с числовым id клиента ('$1'). */
export function clientDealCond(ref: ClientRef, p = '$1'): string {
  if (!ref.startsWith('k')) return `d.contact_id = ${p}`;
  return `(d.company_id = ${p} OR (
    d.funnel_id IN (1,3) AND d.contact_id IN (${companyContacts(p)})
    AND (coalesce(d.company_id, 0) = 0 OR NOT EXISTS (
      SELECT 1 FROM sa.deals o WHERE o.company_id = d.company_id AND o.funnel_id IN (0,1,2,3)
        AND (o.contact_id IS NULL OR o.contact_id NOT IN (${companyContacts(p)}))
    ))
  ))`;
}
