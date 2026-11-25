// «Большой брат» — что из адреса страницы можно писать в журнал (клиент и сервер, без серверных зависимостей).
// Только белый список ключей и только безопасные значения: id и служебные коды, никаких строк поиска,
// значений фильтров, телефонов и имён. Сервер прогоняет через тот же фильтр ещё раз — клиенту не доверяем.
const SLUG = /^[a-z0-9_-]{1,40}$/i;
const ID = /^\d{1,15}$/;
const CUSTOMER = /^[a-z]{1,12}[:_-]?\d{1,15}$/i; // clientKey заказчика: 'contact:123', 'company_45', '123'

const RULES: Record<string, RegExp> = {
  tab: SLUG,        // вкладка ЛК / карточки менеджера / профиля
  view: SLUG,       // вид раздела (Задачник: board/week/today)
  customer: CUSTOMER, // заказчик в ЛК (?customer=<clientKey>)
  client: ID,       // карточка клиента в отчёте (?client=<contactId>)
  deal: ID,         // сделка (/bx/deal-requests?deal=…, канбаны)
  src: SLUG,        // откуда пришёл: 'bot' — ссылка из сообщения бота
  m: /^[0-9a-z-]{1,40}$/i, // id сообщения бота (bot_message_log.id)
};

/** Безопасные пары из query-строки ('?a=1&b=2'). Пусто — {}. */
export function safeQuery(search: string | Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!search) return out;
  const entries: [string, unknown][] = typeof search === 'string'
    ? [...new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).entries()]
    : Object.entries(search);
  for (const [k, v] of entries) {
    const re = RULES[k];
    if (re && typeof v === 'string' && re.test(v)) out[k] = v;
  }
  return out;
}

/** Сущность просмотра: карточка менеджера, клиента, заказчика, сделки. */
export function viewEntity(path: string, q: Record<string, string>): { entityType: string; entityId: string; dealId?: number } | null {
  const mgr = path.match(/^\/manager\/(\d{1,15})(?:\/|$)/);
  if (q.deal) return { entityType: 'deal', entityId: q.deal, dealId: Number(q.deal) };
  if (q.client) return { entityType: 'client', entityId: q.client };
  if (q.customer) return { entityType: 'customer', entityId: q.customer };
  if (mgr) return { entityType: 'manager', entityId: mgr[1] };
  return null;
}
