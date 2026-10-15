// Юрлицо/ИП клиента по ЕГРЮЛ (DaData findById/party) — для подсказки «что это
// за клиент» на «Обзоре» (идея владельца 15.10: «через дадату смотреть ОКВЭДы и
// анализировать юрлицо»).
//
// ИНН берём из реквизитов клиента в Битриксе (crm.requisite.list: компания — тип
// 4, контакт — тип 3, у контактов это обычно ИП). Покрытие на 15.10: реквизиты
// есть у ~5% компаний и у ~30 тыс. контактов — у кого нет, подсказка строится
// только по сделкам.
//
// Бесплатный тариф DaData отдаёт: название и ОПФ, тип (ЮЛ/ИП), ОСНОВНОЙ ОКВЭД,
// статус (действует / ликвидируется / ликвидирована), даты регистрации и
// ликвидации, адрес. Дополнительные ОКВЭДы, выручка и численность — пусто (платно).
// Только чтение; результат в Redis на сутки, сбои (DaData/Битрикс) не кешируются.

import { bx } from '@/lib/bitrix/notify';
import { cached } from '@/lib/cache/redis';
import type { ClientRef } from './types';

export type OkvedKind = 'construction' | 'design' | 'realty' | 'building_trade' | 'other';

export interface LegalEntity {
  inn: string;
  name: string;
  /** ЮЛ или ИП. */
  kind: 'legal' | 'individual';
  okved: string | null;
  okvedName: string | null;
  okvedKind: OkvedKind;
  status: 'active' | 'liquidating' | 'liquidated' | 'other';
  registeredAt: string | null;
  liquidatedAt: string | null;
  region: string | null;
}

// Сутки: менеджер добавил реквизиты — подсказка обновится на следующий день.
const TTL = 24 * 3600;

/** Раздел ОКВЭД → что это значит для нас. */
export function okvedKind(code: string | null): OkvedKind {
  if (!code) return 'other';
  if (/^4[123]\./.test(code) || /^4[123]$/.test(code)) return 'construction';     // F: строительство
  if (/^71\.1/.test(code)) return 'design';                                         // архитектура, инженерные изыскания
  if (/^68\./.test(code)) return 'realty';                                          // операции с недвижимостью
  if (/^46\.7[234]|^47\.52|^46\.13/.test(code)) return 'building_trade';             // торговля стройматериалами, металлом
  return 'other';
}

async function dadata<T>(path: string, body: object): Promise<T | null> {
  const token = process.env.DADATA_TOKEN;
  if (!token) return null;
  // Сбой — исключение (не кешируем); «не нашли» — пустой ответ.
  const r = await fetch(`https://suggestions.dadata.ru/suggestions/api/4_1/rs/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`DaData ${path}: ${r.status}`);
  return await r.json() as T;
}

async function innFromBitrix(ref: ClientRef): Promise<string | null> {
  const w = process.env.BITRIX_WEBHOOK_URL ?? '';
  if (!w) return null;
  const isCompany = ref.startsWith('k');
  const body = await bx(w, 'crm.requisite.list', {
    filter: { ENTITY_TYPE_ID: isCompany ? 4 : 3, ENTITY_ID: Number(ref.slice(1)) },
    select: ['RQ_INN'],
  }) as { result?: { RQ_INN?: string | null }[] };
  for (const r of body.result ?? []) {
    const inn = (r.RQ_INN ?? '').replace(/\D/g, '');
    if (inn.length === 10 || inn.length === 12) return inn;
  }
  return null;
}

type PartyData = {
  type?: string; okved?: string | null; name?: { short_with_opf?: string; full_with_opf?: string };
  state?: { status?: string; registration_date?: number | null; liquidation_date?: number | null };
  address?: { data?: { region_with_type?: string | null } };
};

async function party(inn: string): Promise<LegalEntity | null> {
  const j = await dadata<{ suggestions?: { value: string; data: PartyData }[] }>('findById/party', { query: inn, count: 1, branch_type: 'MAIN' });
  const s = j?.suggestions?.[0];
  if (!s) return null;
  const d = s.data;
  const okved = d.okved ?? null;
  let okvedName: string | null = null;
  if (okved) {
    const o = await dadata<{ suggestions?: { value: string }[] }>('findById/okved2', { query: okved });
    okvedName = o?.suggestions?.[0]?.value ?? null;
  }
  const st = d.state?.status;
  const date = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
  return {
    inn,
    name: d.name?.short_with_opf || s.value,
    kind: d.type === 'INDIVIDUAL' ? 'individual' : 'legal',
    okved, okvedName, okvedKind: okvedKind(okved),
    status: st === 'ACTIVE' ? 'active' : st === 'LIQUIDATING' || st === 'BANKRUPT' || st === 'REORGANIZING' ? 'liquidating' : st === 'LIQUIDATED' ? 'liquidated' : 'other',
    registeredAt: date(d.state?.registration_date),
    liquidatedAt: date(d.state?.liquidation_date),
    region: d.address?.data?.region_with_type ?? null,
  };
}

/** Юрлицо клиента по реквизитам Битрикса → ЕГРЮЛ. null — ИНН нет / не нашли. */
export async function fetchLegalEntity(ref: ClientRef): Promise<LegalEntity | null> {
  try {
    return await cached(`client-module:legal:v1:${ref}`, TTL, async () => {
      const inn = await innFromBitrix(ref);
      return inn ? await party(inn) : null;
    });
  } catch (e) {
    console.warn('[legalEntity]', ref, e instanceof Error ? e.message : e);
    return null;
  }
}
