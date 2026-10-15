import { bx } from '@/lib/bitrix/notify';
import type { ClientRef, ClientType } from './types';

// Модуль «Карточка клиента» ↔ Битрикс (решение владельца 13.10): источник
// правды по ручным полям КЛИЕНТА — Битрикс, sa — копия для чтения приложением.
// Объекты в Битрикс НЕ пишутся (v2, 13.10 вечер: смарт-процесс «Объекты»
// упразднён, объекты живут только в Монолитике).
// Виджет пишет СНАЧАЛА сюда, при успехе — в sa; ручная правка этих полей в
// интерфейсе Битрикса закрыта (EDIT_IN_LIST=N, права смарт-процесса — только
// чтение), расхождения закрывает ночная сверка (lib/jobs/clientModuleSync.ts).
// Все ID ниже созданы 13.10 — см. WORKLOG «Битрикс: поля клиента…» и
// «смарт-процесс «Объекты»».

// ── Поля клиента (контакт / компания) ───────────────────────────────────────
const TYPE_FIELD = { contact: 'UF_CRM_677E46F756A7B', company: 'UF_CRM_677E46F8B8F06' } as const;
const OCCUPATION_FIELD = 'UF_CRM_MLT_OCCUPATION';
const NOTE_FIELD = 'UF_CRM_MLT_CLIENT_NOTE';

/** ID вариантов списка «Тип клиента»: у контакта и компании поля разные. */
const TYPE_ENUM: Record<'contact' | 'company', Record<ClientType, number>> = {
  contact: { construction_org: 153, own_needs_org: 1118, foreman: 154, self_builder: 155, self_builder_late: 1126 },
  company: { construction_org: 180, own_needs_org: 1120, foreman: 181, self_builder: 182, self_builder_late: 1128 },
};

export class BitrixWriteError extends Error {}

function webhook(): string {
  const w = process.env.BITRIX_WEBHOOK_URL ?? '';
  if (!w) throw new BitrixWriteError('Не задан BITRIX_WEBHOOK_URL — запись в Битрикс невозможна');
  return w;
}

async function call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
  try {
    const body = await bx(webhook(), method, params) as { result: T };
    return body.result;
  } catch (e) {
    if (e instanceof BitrixWriteError) throw e;
    throw new BitrixWriteError(`Битрикс ${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Один вызов без автоповтора — для создания: повтор после таймаута мог бы
 *  завести второй объект (первый запрос мог дойти до Битрикса). */
async function callOnce<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${webhook().replace(/\/+$/, '')}/${method}.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new BitrixWriteError(`Битрикс ${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await res.json().catch(() => null) as { result?: T; error?: string; error_description?: string } | null;
  if (!res.ok || !body || body.error) throw new BitrixWriteError(`Битрикс ${method}: ${body?.error ?? `HTTP ${res.status}`} ${body?.error_description ?? ''}`.trim());
  return body.result as T;
}

const entityOf = (ref: ClientRef) => (ref.startsWith('k') ? 'company' : 'contact') as 'contact' | 'company';
const idOf = (ref: ClientRef) => Number(ref.slice(1));

// ── Клиент ──────────────────────────────────────────────────────────────────

export interface BitrixClientFields { clientType: ClientType | null; enumId: number | null; occupation: string; note: string }

export function clientTypeFromEnum(entity: 'contact' | 'company', enumId: unknown): ClientType | null {
  const n = Number(enumId);
  if (!n) return null;
  const hit = (Object.entries(TYPE_ENUM[entity]) as [ClientType, number][]).find(([, v]) => v === n);
  return hit ? hit[0] : null;
}

export function parseClientRow(entity: 'contact' | 'company', row: Record<string, unknown>): BitrixClientFields {
  const enumId = Number(row[TYPE_FIELD[entity]]) || null;
  return {
    clientType: clientTypeFromEnum(entity, enumId),
    enumId,
    occupation: String(row[OCCUPATION_FIELD] ?? ''),
    note: String(row[NOTE_FIELD] ?? ''),
  };
}

export const CLIENT_SELECT = (entity: 'contact' | 'company') => ['ID', TYPE_FIELD[entity], OCCUPATION_FIELD, NOTE_FIELD];

export async function readClientFromBitrix(ref: ClientRef): Promise<BitrixClientFields | null> {
  const entity = entityOf(ref);
  const row = await call<Record<string, unknown> | null>(`crm.${entity}.get`, { id: idOf(ref) });
  return row ? parseClientRow(entity, row) : null;
}

export async function writeClientToBitrix(ref: ClientRef, v: { clientType: ClientType | null; occupation: string; note: string }): Promise<number | null> {
  const entity = entityOf(ref);
  const enumId = v.clientType ? TYPE_ENUM[entity][v.clientType] : null;
  await call(`crm.${entity}.update`, {
    id: idOf(ref),
    fields: { [TYPE_FIELD[entity]]: enumId ?? '', [OCCUPATION_FIELD]: v.occupation, [NOTE_FIELD]: v.note },
    params: { REGISTER_SONET_EVENT: 'N' },
  });
  return enumId;
}

/** Поля клиентов пачкой (≤50 ID) — для ночной сверки. */
export async function readClientsFromBitrix(entity: 'contact' | 'company', ids: number[]): Promise<Map<number, BitrixClientFields>> {
  const out = new Map<number, BitrixClientFields>();
  if (ids.length === 0) return out;
  const rows = await call<Record<string, unknown>[]>(`crm.${entity}.list`, { filter: { '@ID': ids }, select: CLIENT_SELECT(entity) });
  for (const r of rows ?? []) out.set(Number(r.ID), parseClientRow(entity, r));
  return out;
}

export { entityOf, idOf };
