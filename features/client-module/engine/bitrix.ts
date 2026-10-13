import { bx } from '@/lib/bitrix/notify';
import type { ClientRef, ClientType, BuildStage, HouseType } from './types';

// Модуль «Карточка клиента» ↔ Битрикс (решение владельца 13.10): источник
// правды по ручным полям — Битрикс, sa — копия для чтения приложением.
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
  contact: { construction_org: 153, own_needs_org: 1118, foreman: 154, self_builder: 155 },
  company: { construction_org: 180, own_needs_org: 1120, foreman: 181, self_builder: 182 },
};

// ── Смарт-процесс «Объекты» ────────────────────────────────────────────────
export const OBJECTS_ENTITY_TYPE_ID = 1108;
const STAGE = { none: 'DT1108_25:NEW', start: 'DT1108_25:PREPARATION', mid_end: 'DT1108_25:CLIENT', done: 'DT1108_25:SUCCESS', inactive: 'DT1108_25:FAIL' } as const;
export const OBJ = {
  address1c: 'UF_CRM_18_ADDRESS',
  addressIdeal: 'UF_CRM_18_ADDRESS_IDEAL',
  lat: 'UF_CRM_18_LAT',
  lon: 'UF_CRM_18_LON',
  houseType: 'UF_CRM_18_HOUSE_TYPE',
  note: 'UF_CRM_18_NOTE',
  key: 'UF_CRM_18_OBJECT_KEY',
} as const;
const HOUSE_ENUM: Record<HouseType, number> = { frame: 1124, aerated: 1125 };

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

// ── Объект ──────────────────────────────────────────────────────────────────

export type StoredStage = BuildStage | 'done' | 'inactive' | null;

export function stageFromBitrix(stageId: unknown): StoredStage {
  switch (stageId) {
    case STAGE.start: return 'start';
    case STAGE.mid_end: return 'mid_end';
    case STAGE.done: return 'done';
    case STAGE.inactive: return 'inactive';
    default: return null;
  }
}

export function houseFromBitrix(v: unknown): HouseType | null {
  const n = Number(v);
  return n === HOUSE_ENUM.frame ? 'frame' : n === HOUSE_ENUM.aerated ? 'aerated' : null;
}

export interface BitrixObjectInput {
  itemId: number | null;
  key: string;
  address1c: string | null;
  idealAddress: string | null;
  lat: number | null;
  lon: number | null;
  /** undefined — стадию не трогать (её мог поставить админ: «завершена»/«неактуален»). */
  stage: StoredStage | undefined;
  houseType: HouseType | null;
  note: string;
}

export interface BitrixObjectRow {
  id: number;
  title: string;
  stageId: string;
  contactId: number | null;
  companyId: number | null;
  [uf: string]: unknown;
}

const ITEM_SELECT = ['id', 'title', 'stageId', 'contactId', 'companyId', ...Object.values(OBJ)];

/** Создаёт или обновляет элемент «Объекты» и возвращает его ID. Повторный вызов
 *  без itemId не плодит дубли: сначала ищем элемент по ключу объекта у клиента. */
export async function writeObjectToBitrix(ref: ClientRef, o: BitrixObjectInput): Promise<number> {
  const entity = entityOf(ref);
  const clientId = idOf(ref);

  let itemId = o.itemId;
  if (!itemId) {
    const found = await call<{ items: BitrixObjectRow[] }>('crm.item.list', {
      entityTypeId: OBJECTS_ENTITY_TYPE_ID, useOriginalUfNames: 'Y', select: ITEM_SELECT,
      filter: { [OBJ.key]: o.key },
    });
    const mine = (found?.items ?? []).find(i => (entity === 'contact' ? Number(i.contactId) : Number(i.companyId)) === clientId);
    itemId = mine ? Number(mine.id) : null;
  }

  const fields: Record<string, unknown> = {
    title: (o.idealAddress || o.address1c || 'Объект').slice(0, 250),
    [OBJ.key]: o.key,
    [OBJ.address1c]: o.address1c ?? '',
    [OBJ.addressIdeal]: o.idealAddress ?? '',
    [OBJ.lat]: o.lat ?? '',
    [OBJ.lon]: o.lon ?? '',
    [OBJ.houseType]: o.houseType ? HOUSE_ENUM[o.houseType] : '',
    [OBJ.note]: o.note,
  };
  if (o.stage !== undefined) fields.stageId = o.stage ? STAGE[o.stage] : STAGE.none;

  if (itemId) {
    await call('crm.item.update', { entityTypeId: OBJECTS_ENTITY_TYPE_ID, id: itemId, useOriginalUfNames: 'Y', fields });
    return itemId;
  }
  if (entity === 'contact') fields.contactIds = [clientId]; else fields.companyId = clientId;
  if (fields.stageId === undefined) fields.stageId = STAGE.none;
  const r = await callOnce<{ item: { id: number } }>('crm.item.add', { entityTypeId: OBJECTS_ENTITY_TYPE_ID, useOriginalUfNames: 'Y', fields });
  const id = Number(r?.item?.id);
  if (!id) throw new BitrixWriteError('Битрикс не вернул ID созданного объекта');
  return id;
}

/** Все элементы «Объектов» — для ночной сверки. */
export async function listAllObjectsFromBitrix(): Promise<BitrixObjectRow[]> {
  const out: BitrixObjectRow[] = [];
  for (let start = 0; start < 100_000;) {
    const body = await bx(webhook(), 'crm.item.list', {
      entityTypeId: OBJECTS_ENTITY_TYPE_ID, useOriginalUfNames: 'Y', select: ITEM_SELECT, order: { id: 'ASC' }, start,
    }) as { result: { items: BitrixObjectRow[] }; next?: number };
    out.push(...(body.result?.items ?? []));
    if (!body.next) break;
    start = body.next;
  }
  return out;
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
