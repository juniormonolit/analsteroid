// Точки расширения для S4 (Битрикс) и S5 (уведомления). Движок вызывает их ПОСЛЕ коммита транзакции;
// ошибка хука не откатывает действие (пишется в лог / статус синка). Тела функций заполняют S4/S5 —
// здесь только сигнатуры и безопасные заглушки. Ни одной ЗАПИСИ в Битрикс в S1.
import type { ActionKind, DealRowsStatus, Offer, RequestDetails } from './contract';

export interface LogistHookCtx {
  action: ActionKind | 'create' | 'message';
  request: RequestDetails;
  actor: { bitrixId: string | null; login: string; name: string };
  /** id событий журнала, добавленных этим действием */
  eventIds: number[];
  /** для action='message' */
  messageId?: number;
}

/** После любого изменения запроса. S4: дубль-задача Битрикса (создать при send, статусы, комментарии);
 *  S5: бот «Аналитик», канал logist_requests. Сейчас — ничего. */
export async function afterLogistChange(ctx: LogistHookCtx): Promise<void> {
  void ctx;
}

/** «Принять вариант» → переписать товары сделки (crm.deal.productrows.set от имени менеджера). S4.
 *  Заглушка: ничего не пишет, возвращает 'skipped' — движок сохранит это в deal_rows_status. */
export async function writeDealRowsForAcceptedOffer(input: {
  request: RequestDetails; offer: Offer; actor: { bitrixId: string | null; login: string };
}): Promise<{ status: DealRowsStatus; error?: string | null }> {
  void input;
  return { status: 'skipped', error: 'Запись товаров сделки ещё не подключена (S4)' };
}
