// Тип клиента для сортировки канбана (прорабы сверху).
//
// Поле «Тип клиента» живёт на контакте/компании Битрикса (UF_CRM_677E46F756A7B /
// UF_CRM_677E46F8B8F06, те же варианты, что в карточке клиента —
// features/client-module/engine/bitrix.ts). В sa копии контактов нет, а
// sa.client_module_profiles заполнен только у заказчиков, открытых в карточке клиента
// (16 на 20.10 против 18,8 тыс. контактов с типом в Битриксе).
//
// Замер 20.10: выгрузка ВСЕХ типизированных фильтром по полю — 58–106 с (фильтр по UF
// в Битриксе без индекса), а точечно по ID — 2 500 контактов за 0,7 с одним batch.
// Поэтому берём тип только заказчиков доски, по ID, с кэшем на менеджера 6 часов.
// Тип из карточки клиента в Монолитике главнее и читается всегда свежим: он пишется в
// Битрикс при сохранении, а кэш Битрикса мог отстать.
import { bx } from '@/lib/bitrix/notify';
import { cached } from '@/lib/cache/redis';
import { analyticsDb } from '@/lib/db/clients';

const FIELD = { contact: 'UF_CRM_677E46F756A7B', company: 'UF_CRM_677E46F8B8F06' } as const;
const ENUM_TO_TYPE: Record<string, string> = {
  153: 'construction_org', 1118: 'own_needs_org', 154: 'foreman', 155: 'self_builder', 1126: 'self_builder_late',
  180: 'construction_org', 1120: 'own_needs_org', 181: 'foreman', 182: 'self_builder', 1128: 'self_builder_late',
};
const IDS_PER_CALL = 50;
const CALLS_PER_BATCH = 50;

/** client_key → client_ref карточки клиента: 'x' (юр-сделка без компании) — это контакт. */
export const clientRefOf = (key: string) => (key.startsWith('x') ? `c${key.slice(1)}` : key);

async function fetchFromBitrix(refs: string[]): Promise<Record<string, string>> {
  const webhook = process.env.BITRIX_WEBHOOK_URL ?? '';
  const out: Record<string, string> = {};
  if (!webhook || !refs.length) return out;
  const calls: { entity: 'contact' | 'company'; ids: number[] }[] = [];
  for (const entity of ['contact', 'company'] as const) {
    const ids = refs.filter(r => r.startsWith(entity === 'contact' ? 'c' : 'k')).map(r => Number(r.slice(1))).filter(n => n > 0);
    for (let i = 0; i < ids.length; i += IDS_PER_CALL) calls.push({ entity, ids: ids.slice(i, i + IDS_PER_CALL) });
  }
  for (let i = 0; i < calls.length; i += CALLS_PER_BATCH) {
    const cmd: Record<string, string> = {};
    calls.slice(i, i + CALLS_PER_BATCH).forEach((c, j) => {
      cmd[`q${j}_${c.entity}`] = `crm.${c.entity}.list?${c.ids.map(id => `filter[@ID][]=${id}`).join('&')}`
        + `&select[]=ID&select[]=${FIELD[c.entity]}&start=-1`;
    });
    try {
      const res = await bx(webhook, 'batch', { halt: 0, cmd }) as { result?: { result?: Record<string, Record<string, string>[]> } };
      for (const [name, rows] of Object.entries(res.result?.result ?? {})) {
        const entity = name.endsWith('_company') ? 'company' : 'contact';
        for (const r of rows) {
          const t = ENUM_TO_TYPE[String(r[FIELD[entity]] ?? '')];
          if (t) out[`${entity === 'contact' ? 'c' : 'k'}${r.ID}`] = t;
        }
      }
    } catch (e) {
      console.warn('[repeat-kanban] типы клиентов из Битрикса не получены:', e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** Тип по каждому заказчику менеджера. cacheKey — чей список (кэш Битрикса на 6 часов). */
export async function fetchClientTypes(cacheKey: string, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const refs = [...new Set(keys.map(clientRefOf))];
  const [profiles, bx24] = await Promise.all([
    analyticsDb().query<{ client_ref: string; client_type: string }>(
      `SELECT client_ref, client_type FROM sa.client_module_profiles WHERE client_ref = ANY($1::text[]) AND client_type IS NOT NULL`,
      [refs],
    ).then(r => new Map(r.rows.map(x => [x.client_ref, x.client_type]))).catch(() => new Map<string, string>()),
    cached(`repeat-kanban:bx-types:v1:${cacheKey}`, 6 * 3600, () => fetchFromBitrix(refs)).catch(() => ({} as Record<string, string>)),
  ]);
  const out = new Map<string, string>();
  for (const k of keys) {
    const ref = clientRefOf(k);
    const t = profiles.get(ref) ?? bx24[ref];
    if (t) out.set(k, t);
  }
  return out;
}
