// Выключатели записи в Битрикс канбана запросов логистам (S4). ПО УМОЛЧАНИЮ ВСЁ ВЫКЛЮЧЕНО.
// На проде env берётся из start.sh / secrets.env (не из .env.local) — после правки нужен рестарт systemd-сервиса.
//
//   LOGIST_BX_WRITE=1          — дубль-задача в проекте очереди + статусы и комментарии (очередь logist_bx_outbox)
//   LOGIST_BX_DEAL_ROWS=1      — «Принять вариант» переписывает товары сделки (crm.deal.productrows.set)
//   LOGIST_BX_ONLY_GROUPS=1,2  — (необязательно) писать только по запросам этих проектов Битрикса (тестовый проект)
//   LOGIST_BX_ONLY_DEALS=10,11 — (необязательно) писать только по этим сделкам (тестовая сделка)
//
// Списки — для проверки на тесте: включить LOGIST_BX_WRITE=1 + LOGIST_BX_ONLY_GROUPS=<тестовый проект>,
// и в боевые проекты не уйдёт ни одной записи. Выключение действует сразу: синк перед каждой операцией
// перечитывает флаг, неотправленное ждёт в очереди (status pending) до включения.

const on = (v: string | undefined) => v === '1' || v === 'true' || v === 'on';
const idList = (v: string | undefined): Set<number> | null => {
  const ids = (v ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return ids.length ? new Set(ids) : null;
};

export interface LogistBxFlags {
  tasks: boolean;
  dealRows: boolean;
  onlyGroups: Set<number> | null;
  onlyDeals: Set<number> | null;
}

export function bxFlags(env: Record<string, string | undefined> = process.env): LogistBxFlags {
  return {
    tasks: on(env.LOGIST_BX_WRITE),
    dealRows: on(env.LOGIST_BX_DEAL_ROWS),
    onlyGroups: idList(env.LOGIST_BX_ONLY_GROUPS),
    onlyDeals: idList(env.LOGIST_BX_ONLY_DEALS),
  };
}

/** Почему по этому запросу в Битрикс не пишем (null — пишем). */
export function tasksBlockedReason(f: LogistBxFlags, groupId: number | null | undefined, dealId: number | null | undefined): string | null {
  if (!f.tasks) return 'Запись в Битрикс выключена (LOGIST_BX_WRITE)';
  if (!groupId) return 'У запроса нет очереди (проекта Битрикса)';
  if (f.onlyGroups && !f.onlyGroups.has(groupId)) return `Проект ${groupId} не в LOGIST_BX_ONLY_GROUPS`;
  if (f.onlyDeals && (!dealId || !f.onlyDeals.has(dealId))) return `Сделка ${dealId ?? '—'} не в LOGIST_BX_ONLY_DEALS`;
  return null;
}

export function dealRowsBlockedReason(f: LogistBxFlags, dealId: number | null | undefined): string | null {
  if (!f.dealRows) return 'Запись товаров сделки выключена (LOGIST_BX_DEAL_ROWS)';
  if (!dealId) return 'Запрос без сделки';
  if (f.onlyDeals && !f.onlyDeals.has(dealId)) return `Сделка ${dealId} не в LOGIST_BX_ONLY_DEALS`;
  return null;
}
