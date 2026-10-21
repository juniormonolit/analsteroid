// Поправки к копии сделок Битрикса для канбана повторных (владелец 21.10: «в карточке клиента
// видно активную сделку, а в канбане — "Нет активной сделки"»).
//
// 1. Сделки без клиента. Синк sa.deals теряет контакт/компанию у части сделок (BACKLOG «Синк
//    sa.deals теряет клиента»): 21.10 — 349 повторных сделок за год, в т.ч. только что созданные
//    кнопкой канбана. Карточка клиента это обходит (ID сделок из Битрикса), канбан — нет: сделка не
//    привязывалась к заказчику, и он висел в пуле. Здесь контакт/компания таких сделок берутся из
//    Битрикса (crm.deal.list по ID, по 50), кэш в памяти 10 минут, обновление в фоне. Сделку,
//    созданную самим канбаном, запоминаем сразу (rememberDealClient) — без ожидания.
// 2. Сделка не в той воронке. У повторного заказчика все сделки, кроме самой первой, должны быть в
//    повторной воронке (2/3); открытая сделка в первичной (0/1) — ошибка менеджера при создании.
//    Канбан её не считает «текущей» (колонки — по повторной воронке), но показывает плашкой и в
//    «Сегодня» → «Не в той воронке».
import { bx } from '@/lib/bitrix/notify';
import { analyticsDb } from '@/lib/db/clients';

export interface DealClient { contactId: number | null; companyId: number | null }

const FIX_TTL_MS = 10 * 60_000;
interface FixState { map: Map<number, DealClient>; at: number; running: Promise<void> | null; manual: Map<number, DealClient> }
const g = globalThis as unknown as { __repeatDealFixes?: FixState };
const st: FixState = (g.__repeatDealFixes ??= { map: new Map(), at: 0, running: null, manual: new Map() });

async function refreshOrphans(): Promise<void> {
  const r = await analyticsDb().query<{ deal_id: string }>(
    `SELECT deal_id::text AS deal_id FROM sa.deals
      WHERE funnel_id IN (2, 3) AND coalesce(contact_id, 0) = 0 AND coalesce(company_id, 0) = 0
        AND created_at > now() - interval '365 days'`,
  );
  const ids = r.rows.map(x => Number(x.deal_id));
  const webhook = process.env.BITRIX_WEBHOOK_URL ?? '';
  const map = new Map<number, DealClient>();
  if (webhook) {
    for (let i = 0; i < ids.length; i += 50) {
      const body = await bx(webhook, 'crm.deal.list', {
        filter: { '@ID': ids.slice(i, i + 50) }, select: ['ID', 'CONTACT_ID', 'COMPANY_ID'],
      }) as { result?: { ID: string; CONTACT_ID: string | null; COMPANY_ID: string | null }[] };
      for (const d of body.result ?? []) {
        const contactId = Number(d.CONTACT_ID) || null, companyId = Number(d.COMPANY_ID) || null;
        if (contactId || companyId) map.set(Number(d.ID), { contactId, companyId });
      }
    }
  }
  st.map = map;
  st.at = Date.now();
  if (ids.length) console.log(`[repeat-kanban] сделок без клиента в sa: ${ids.length}, клиент найден в Битриксе: ${map.size}`);
}

/** Контакт/компания повторных сделок, у которых их нет в sa. Первый вызов процесса ждёт до 8 с,
 *  дальше — из кэша, устаревший обновляется в фоне. */
export async function fetchOrphanDealClients(): Promise<Map<number, DealClient>> {
  const stale = Date.now() - st.at > FIX_TTL_MS;
  if (stale && !st.running) {
    st.running = refreshOrphans()
      .catch(e => console.warn('[repeat-kanban] сделки без клиента:', e instanceof Error ? e.message : e))
      .finally(() => { st.running = null; });
  }
  if (st.at === 0 && st.running) await Promise.race([st.running, new Promise(r => setTimeout(r, 8000))]);
  return new Map([...st.map, ...st.manual]);
}

/** Сделка создана/возвращена кнопкой канбана — клиент известен, синк может отстать. */
export function rememberDealClient(dealId: number, clientKey: string): void {
  const id = Number(clientKey.slice(1));
  st.manual.set(dealId, clientKey.startsWith('k') ? { contactId: null, companyId: id } : { contactId: id, companyId: null });
  if (st.manual.size > 2000) st.manual.clear();
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
