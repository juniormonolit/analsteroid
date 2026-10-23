// Поправки к копии сделок Битрикса для канбана повторных (владелец 21.10: «в карточке клиента
// видно активную сделку, а в канбане — "Нет активной сделки"»).
//
// 1. Сделки без клиента. Синк sa.deals теряет контакт/компанию у части сделок (BACKLOG «Синк
//    sa.deals теряет клиента»; 676 сделок воронок 0–3 на 23.10). Клиент таких сделок берётся из
//    Битрикса (crm.deal.list по ID, по 50) и с 23.10 ХРАНИТСЯ у нас — таблица deal_client_fixes
//    (миграция 253): найденный клиент не меняется — навсегда, ненайденный перепроверяется раз в сутки.
//    Раньше — в памяти процесса (каждые 10 мин и после каждого деплоя заново) плюс карточка клиента
//    отдельно звала crm.deal.list по клиенту при каждом открытии. Теперь обе читают таблицу, а в
//    Битрикс уходят только новые сироты. Сделку, созданную самим канбаном, запоминаем сразу.
// 2. Сделка не в той воронке. У повторного заказчика все сделки, кроме самой первой, должны быть в
//    повторной воронке (2/3); открытая сделка в первичной (0/1) — ошибка менеджера при создании.
//    Канбан её не считает «текущей» (колонки — по повторной воронке), но показывает плашкой и в
//    «Сегодня» → «Не в той воронке».
import { bx } from '@/lib/bitrix/notify';
import { analyticsDb, systemDb } from '@/lib/db/clients';

export interface DealClient { contactId: number | null; companyId: number | null }

const SYNC_EVERY_MS = 10 * 60_000;   // сверка «какие сироты новые» — дёшево, Битрикс только по новым
const RELOAD_EVERY_MS = 2 * 60_000;  // перечитать таблицу в память
const RECHECK_MISS_H = 24;
interface FixState { map: Map<number, DealClient>; loadedAt: number; syncedAt: number; syncing: Promise<void> | null; loading: Promise<void> | null }
const g = globalThis as unknown as { __repeatDealFixes2?: FixState };
const st: FixState = (g.__repeatDealFixes2 ??= { map: new Map(), loadedAt: 0, syncedAt: 0, syncing: null, loading: null });

async function loadFixes(): Promise<void> {
  const r = await systemDb().query<{ deal_id: string; contact_id: string | null; company_id: string | null }>(
    'SELECT deal_id::text, contact_id::text, company_id::text FROM deal_client_fixes WHERE found',
  );
  st.map = new Map(r.rows.map(x => [Number(x.deal_id), { contactId: Number(x.contact_id) || null, companyId: Number(x.company_id) || null }]));
  st.loadedAt = Date.now();
}

/** Дотянуть из Битрикса клиента новых сирот (и ненайденных — раз в сутки), записать в таблицу. */
async function syncFixes(): Promise<void> {
  const orphans = (await analyticsDb().query<{ deal_id: string }>(
    `SELECT deal_id::text AS deal_id FROM sa.deals
      WHERE funnel_id IN (0, 1, 2, 3) AND coalesce(contact_id, 0) = 0 AND coalesce(company_id, 0) = 0`,
  )).rows.map(x => Number(x.deal_id));
  if (!orphans.length) return;
  const known = await systemDb().query<{ deal_id: string; found: boolean; stale: boolean }>(
    `SELECT deal_id::text, found, checked_at < now() - ($2 || ' hours')::interval AS stale FROM deal_client_fixes WHERE deal_id = ANY($1::bigint[])`,
    [orphans, String(RECHECK_MISS_H)],
  );
  const have = new Map(known.rows.map(x => [Number(x.deal_id), x]));
  const todo = orphans.filter(id => { const k = have.get(id); return !k || (!k.found && k.stale); });
  const webhook = process.env.BITRIX_WEBHOOK_URL ?? '';
  if (!todo.length || !webhook) return;
  let found = 0;
  for (let i = 0; i < todo.length; i += 50) {
    const part = todo.slice(i, i + 50);
    const body = await bx(webhook, 'crm.deal.list', {
      filter: { '@ID': part }, select: ['ID', 'CONTACT_ID', 'COMPANY_ID'],
    }) as { result?: { ID: string; CONTACT_ID: string | null; COMPANY_ID: string | null }[] };
    const got = new Map((body.result ?? []).map(d => [Number(d.ID), { contactId: Number(d.CONTACT_ID) || null, companyId: Number(d.COMPANY_ID) || null }]));
    for (const id of part) {
      const c = got.get(id);
      const ok = !!c && !!(c.contactId || c.companyId);
      if (ok) found++;
      await systemDb().query(
        `INSERT INTO deal_client_fixes (deal_id, contact_id, company_id, found, checked_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (deal_id) DO UPDATE SET contact_id = EXCLUDED.contact_id, company_id = EXCLUDED.company_id, found = EXCLUDED.found, checked_at = now()
         WHERE NOT deal_client_fixes.found`,
        [id, ok ? c!.contactId : null, ok ? c!.companyId : null, ok],
      );
    }
  }
  console.log(`[deal-client-fixes] сирот в sa: ${orphans.length}, спросили Битрикс: ${todo.length}, клиент найден: ${found}`);
  await loadFixes();
}

function kick(): void {
  if (Date.now() - st.syncedAt > SYNC_EVERY_MS && !st.syncing) {
    st.syncedAt = Date.now();
    st.syncing = syncFixes()
      .catch(e => console.warn('[deal-client-fixes] сверка:', e instanceof Error ? e.message : e))
      .finally(() => { st.syncing = null; });
  }
}

/** Контакт/компания сделок, у которых их нет в sa (из таблицы; новые сироты дотягиваются в фоне). */
export async function fetchOrphanDealClients(): Promise<Map<number, DealClient>> {
  if (Date.now() - st.loadedAt > RELOAD_EVERY_MS) {
    st.loading ??= loadFixes().catch(e => console.warn('[deal-client-fixes] чтение:', e instanceof Error ? e.message : e)).finally(() => { st.loading = null; });
    if (st.loadedAt === 0) await st.loading;
  }
  kick();
  return st.map;
}

/** Сделки клиента, которые синк sa потерял (для карточки клиента) — без запросов в Битрикс. */
export async function orphanDealIdsOf(entity: 'contact' | 'company', id: number): Promise<number[]> {
  kick();
  const r = await systemDb().query<{ deal_id: string }>(
    `SELECT deal_id::text FROM deal_client_fixes WHERE found AND ${entity === 'company' ? 'company_id' : 'contact_id'} = $1`, [id],
  ).catch(() => ({ rows: [] as { deal_id: string }[] }));
  return r.rows.map(x => Number(x.deal_id));
}

/** Сделка создана/возвращена кнопкой канбана — клиент известен, синк может отстать. */
export function rememberDealClient(dealId: number, clientKey: string): void {
  const id = Number(clientKey.slice(1));
  const c: DealClient = clientKey.startsWith('k') ? { contactId: null, companyId: id } : { contactId: id, companyId: null };
  st.map.set(dealId, c);
  void systemDb().query(
    `INSERT INTO deal_client_fixes (deal_id, contact_id, company_id, found, source) VALUES ($1, $2, $3, true, 'kanban')
     ON CONFLICT (deal_id) DO NOTHING`, [dealId, c.contactId, c.companyId],
  ).catch(() => {});
}

export interface WrongFunnelDeal { dealId: number; funnelId: number; funnelName: string | null; stageName: string | null; createdAt: string }

/** Открытые сделки НЕ первые у заказчика, но в первичной воронке (0/1). Ключ — ref доски:
 *  k<компания> для юр-сделки с компанией, иначе p<контакт>. Самая свежая на заказчика. */
export async function fetchWrongFunnelDeals(refs: string[]): Promise<Map<string, WrongFunnelDeal>> {
  if (!refs.length) return new Map();
  const r = await analyticsDb().query<{ ref: string; deal_id: string; funnel_id: number; funnel_name: string | null; stage_name: string | null; created_at: Date }>(
    `WITH d AS (
       SELECT CASE WHEN d.funnel_id IN (1, 3) AND coalesce(d.company_id, 0) <> 0 THEN 'k' || d.company_id
                   WHEN coalesce(d.contact_id, 0) <> 0 THEN 'p' || d.contact_id END AS ref,
              d.deal_id, d.funnel_id, d.created_at, d.stage_id
         FROM sa.deals d WHERE d.funnel_id IN (0, 1, 2, 3)
     ), firsts AS (
       SELECT ref, min(created_at) AS first_at FROM d WHERE ref = ANY($1::text[]) GROUP BY 1
     )
     SELECT DISTINCT ON (d.ref) d.ref, d.deal_id::text AS deal_id, d.funnel_id, f.name AS funnel_name, s.name AS stage_name, d.created_at
       FROM d JOIN firsts USING (ref)
       JOIN sa.stages s ON s.id = d.stage_id
       LEFT JOIN sa.funnels f ON f.id = d.funnel_id
      WHERE d.funnel_id IN (0, 1) AND d.created_at > firsts.first_at + interval '1 minute'
        AND s.event_type IN ('created', 'called', 'reserved', 'confirmed')
      ORDER BY d.ref, d.created_at DESC`,
    [refs],
  ).catch(e => { console.warn('[repeat-kanban] сделки не в той воронке:', e instanceof Error ? e.message : e); return { rows: [] }; });
  return new Map(r.rows.map(x => [x.ref, {
    dealId: Number(x.deal_id), funnelId: x.funnel_id, funnelName: x.funnel_name, stageName: x.stage_name,
    createdAt: new Date(x.created_at).toISOString(),
  }]));
}
