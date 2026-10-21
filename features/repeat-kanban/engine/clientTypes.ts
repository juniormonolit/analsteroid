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
import { analyticsDb, systemDb } from '@/lib/db/clients';

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

// Общая карта типов на всю компанию (21.10, канбан на всю компанию): хранится в нашей БД
// (customer_snapshot_meta.client_types, переживает выкатку), в памяти процесса — для чтения.
// Новые заказчики дотягиваются из Битрикса по ID: до SYNC_LIMIT — сразу, больше — в фоне
// (первая загрузка всей компании не должна ждать ~450 запросов). Раз в 6 ч карта
// перепроверяется целиком в фоне — тип в Битриксе могли поменять.
const TYPES_TTL_MS = 6 * 3600_000;
const SYNC_LIMIT = 3000;
interface TypesState { map: Map<string, string>; checked: Set<string>; at: number; loadP: Promise<void> | null; chain: Promise<void> }
const gt = globalThis as unknown as { __repeatClientTypes?: TypesState };
const ts: TypesState = (gt.__repeatClientTypes ??= { map: new Map(), checked: new Set(), at: 0, loadP: null, chain: Promise.resolve() });

function loadTypes(): Promise<void> {
  ts.loadP ??= systemDb().query<{ t: Record<string, string> | null; at: Date | null }>(
    `SELECT client_types AS t, client_types_at AS at FROM customer_snapshot_meta WHERE id = 1`,
  ).then(r => {
    const row = r.rows[0];
    if (!row?.t || !row.at) return;
    for (const [k, v] of Object.entries(row.t)) { ts.map.set(k, v); ts.checked.add(k); }
    ts.at = new Date(row.at).getTime();
  }).catch(e => { console.warn('[repeat-kanban] типы из БД:', e instanceof Error ? e.message : e); ts.loadP = null; });
  return ts.loadP;
}

/** Дотянуть типы из Битрикса (последовательно — не больше одной выгрузки разом) и сохранить. */
function fillTypes(refs: string[], full: boolean): Promise<void> {
  ts.chain = ts.chain.then(async () => {
    const todo = full ? refs : refs.filter(r => !ts.checked.has(r));
    if (!todo.length) return;
    const got = await fetchFromBitrix(todo);
    for (const r of todo) {
      ts.checked.add(r);
      if (got[r]) ts.map.set(r, got[r]); else if (full) ts.map.delete(r);
    }
    if (full || !ts.at) ts.at = Date.now();
    await systemDb().query(
      `INSERT INTO customer_snapshot_meta (id, computed_at, client_types, client_types_at) VALUES (1, to_timestamp(0), $1::jsonb, $2)
       ON CONFLICT (id) DO UPDATE SET client_types = EXCLUDED.client_types, client_types_at = EXCLUDED.client_types_at`,
      [JSON.stringify(Object.fromEntries(ts.map)), new Date(ts.at)],
    ).catch(e => console.warn('[repeat-kanban] типы в БД:', e instanceof Error ? e.message : e));
  }).catch(e => console.warn('[repeat-kanban] типы из Битрикса:', e instanceof Error ? e.message : e));
  return ts.chain;
}

/** Тип по каждому заказчику (любой набор, хоть вся компания). */
export async function fetchClientTypesBulk(keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const refs = [...new Set(keys.map(clientRefOf))];
  await loadTypes();
  if (Date.now() - ts.at > TYPES_TTL_MS && ts.at > 0) void fillTypes(refs, true);
  const missing = refs.filter(r => !ts.checked.has(r));
  if (missing.length) {
    const p = fillTypes(missing, false);
    if (missing.length <= SYNC_LIMIT) await p;
  }
  const profiles = await analyticsDb().query<{ client_ref: string; client_type: string }>(
    `SELECT client_ref, client_type FROM sa.client_module_profiles WHERE client_ref = ANY($1::text[]) AND client_type IS NOT NULL`,
    [refs],
  ).then(r => new Map(r.rows.map(x => [x.client_ref, x.client_type]))).catch(() => new Map<string, string>());
  const out = new Map<string, string>();
  for (const k of keys) {
    const ref = clientRefOf(k);
    const t = profiles.get(ref) ?? ts.map.get(ref);
    if (t) out.set(k, t);
  }
  return out;
}
