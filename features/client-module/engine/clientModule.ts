import { analyticsDb } from '@/lib/db/clients';
import { resolveClientNames } from '@/lib/bitrix/clientNames';
import { fetchDealAddresses } from '@/lib/bitrix/dealAddress';
import { fetchCrossSellMatrix, fetchCrossSellPriorities } from '@/features/customers/engine/crossSell';
import {
  type ClientRef, type ClientModuleData, type ModuleDeal, type ModuleObject, type ModuleProduct,
  type ClientProfile, type ObjectProfile, type ClientType, type BuildStage, type HouseType, type StageLadder,
  CLIENT_TYPES, BUILD_STAGES, HOUSE_TYPES, EMPTY_PROFILE, EMPTY_OBJECT_PROFILE, NEW_OBJECT_KEY, DEFAULT_ACTIVE_DAYS,
  requestObjectKey, dealStage,
} from './types';
import { BitrixWriteError, readClientFromBitrix, writeClientToBitrix } from './bitrix';
import { recommendGroups, stageLadder, profileKind } from './recommend';
import { clusterAddresses, settlementLabel, placeDetail } from './objectClusters';
import { validLatLon } from '@/lib/geo/parse';

// Модуль «Карточка клиента» (ТЗ владельца 13.10). Один виджет для «Ещё → Модули»
// (превью для админов) и для вкладки в карточке контакта/компании Битрикса.
//
// Клиент — то, по чему открыли: contactId → ВСЕ сделки с этим contact_id (физ. и
// юр.), companyId → все сделки компании; воронки 0–3. Сознательно НЕ сегментация
// «Моих заказчиков» — виджет стоит в карточке конкретной сущности Битрикса.
//
// v2 (13.10, вечер): объекты ведутся ТОЛЬКО в Монолитике (смарт-процесс в
// Битриксе упразднён). Адрес объекта проставляется автоматически:
//   1) заявки Пульта/1С (sa.request_addresses, bitrix_id = ID сделки);
//   2) нет заявки — адрес сделки в Битриксе (UF_ADDRESS_COORDS, кэш deal_addresses);
// менеджер видит плашку «Проверь адрес» и может поправить. У каждой сделки ОДИН
// объект: ручная привязка (sa.client_module_deal_objects) → заявка 1С → Битрикс.
// В Битрикс пишутся только поля клиента (тип, «чем занимается», заметка).

const NON_GOODS_RE = /^(доставка|перевозка|услуг|разное)/i;
/** Сколько сделок без заявки 1С досматриваем в Битриксе за раз (свежие — первыми). */
const BITRIX_ADDRESS_LIMIT = 300;

function iso(v: string | Date | null): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

interface RawProduct { name?: string; type?: string; price?: number | string; quantity?: number | string; sum?: number | string; head_group_name?: string }

function mapProducts(raw: unknown): ModuleProduct[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawProduct[]).map(p => {
    const group = (p.head_group_name ?? '').trim() || null;
    return {
      name: p.name ?? '—',
      quantity: Number(p.quantity) || 0,
      price: Number(p.price) || 0,
      sum: Number(p.sum) || 0,
      group,
      isService: (p.type ?? '') === 'услуга' || (group !== null && NON_GOODS_RE.test(group)),
    };
  });
}

export function parseClientRef(contactId: string | null, companyId: string | null): ClientRef | null {
  if (companyId && /^\d{1,12}$/.test(companyId)) return `k${Number(companyId)}`;
  if (contactId && /^\d{1,12}$/.test(contactId)) return `c${Number(contactId)}`;
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>(res => { t = setTimeout(() => res(fallback), ms); });
  try { return await Promise.race([p.catch(() => fallback), timer]); } finally { clearTimeout(t); }
}

const isOneOf = <T extends string>(list: ReadonlyArray<{ value: T }>, v: unknown): v is T =>
  typeof v === 'string' && list.some(x => x.value === v);

const num = (v: unknown) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

const isMissingColumn = (e: unknown) => e instanceof Error && /column .* does not exist|relation .* does not exist/i.test(e.message);

// ── Настройки модуля (sa.client_module_settings, миграция 006) ────────────

export async function getActiveDays(): Promise<{ days: number; available: boolean }> {
  try {
    const r = await analyticsDb().query<{ value: unknown }>(`SELECT value FROM sa.client_module_settings WHERE key = 'object_active_days'`);
    const n = Number(r.rows[0]?.value);
    return { days: Number.isInteger(n) && n > 0 ? n : DEFAULT_ACTIVE_DAYS, available: true };
  } catch {
    return { days: DEFAULT_ACTIVE_DAYS, available: false };
  }
}

export async function setActiveDays(days: number, by: string): Promise<void> {
  await analyticsDb().query(
    `INSERT INTO sa.client_module_settings (key, value, updated_by, updated_at) VALUES ('object_active_days', $1::jsonb, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(days), by],
  );
}

// ── Чтение ────────────────────────────────────────────────────────────────

export async function fetchClientModule(ref: ClientRef): Promise<ClientModuleData> {
  const db = analyticsDb();
  const isCompany = ref.startsWith('k');
  const id = Number(ref.slice(1));

  const dealsRes = await db.query<{
    deal_id: number; deal_name: string | null; amount: string | null;
    created_at: Date | null; sold_at: Date | null; delivered_at: Date | null; lost_at: Date | null;
    stage_name: string | null; manager_name: string | null; products: unknown;
  }>(
    `SELECT d.deal_id, d.deal_name, d.amount::text AS amount,
            d.created_at, d.sold_at, d.delivered_at, d.lost_at,
            s.name AS stage_name, org.manager_name, d.products
       FROM sa.deals d
       LEFT JOIN sa.stages s ON s.id = d.stage_id
       LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = d.current_manager_id::text
      WHERE d.funnel_id IN (0,1,2,3) AND ${isCompany ? 'd.company_id' : 'd.contact_id'} = $1
      ORDER BY d.created_at DESC NULLS LAST, d.deal_id DESC
      LIMIT 3000`,
    [id],
  );
  const dealIds = dealsRes.rows.map(r => Number(r.deal_id));

  // ── Объекты: адреса из заявок 1С и сделок Битрикса → склейка ─────────────
  // Сначала собираем «сырые» адреса (ключ requestObjectKey — по нему сохранены
  // ручные поля), потом склеиваем похожие в один объект (objectClusters.ts:
  // координаты ≤ 500 м или похожий текст в том же населённом пункте; адрес
  // «только город» и иностранный — не объект).
  type Raw = { key: string; address: string | null; lat: number | null; lon: number | null; source: '1c' | 'bitrix'; requests: { number: string; date: string | null }[]; deals: Set<number> };
  const raws = new Map<string, Raw>();
  const dealRaw = new Map<number, string>();          // сделка → сырой адрес (свежая заявка побеждает)
  const dealAddrText = new Map<number, string>();     // сделка → текст адреса (для «адрес неточный»)
  let addressesAvailable = false;
  const addRaw = (dealId: number, address: string | null, lat: number | null, lon: number | null, source: '1c' | 'bitrix', req?: { number: string; date: string | null }) => {
    if (address) dealAddrText.set(dealId, address);
    const key = requestObjectKey(address, lat, lon);
    if (!key) return;
    const r = raws.get(key) ?? { key, address, lat, lon, source, requests: [], deals: new Set<number>() };
    if (address) r.address = address;
    if (r.lat === null && lat !== null) { r.lat = lat; r.lon = lon; }
    if (req) r.requests.push(req);
    r.deals.add(dealId);
    raws.set(key, r);
    dealRaw.set(dealId, key);
  };
  if (dealIds.length > 0) {
    try {
      const addr = await db.query<{ bitrix_id: string; request_number: string | null; request_date: Date | string | null; address: string | null; lat: number | string | null; lon: number | string | null }>(
        `SELECT bitrix_id::text AS bitrix_id, request_number, request_date, address, lat, lon
           FROM sa.request_addresses
          WHERE bitrix_id = ANY($1::bigint[])
          ORDER BY request_date ASC NULLS FIRST`,
        [dealIds],
      );
      addressesAvailable = true;
      for (const r of addr.rows) {
        const lat = num(r.lat), lon = num(r.lon);
        const ok = lat !== null && lon !== null && validLatLon(lat, lon);
        addRaw(Number(r.bitrix_id), (r.address ?? '').trim() || null, ok ? lat : null, ok ? lon : null, '1c',
          r.request_number ? { number: r.request_number, date: iso(r.request_date) } : undefined);
      }
    } catch (e) {
      console.warn('[clientModule] sa.request_addresses недоступна:', e instanceof Error ? e.message : e);
    }
  }
  // Адрес сделки в Битриксе — для сделок без заявки 1С.
  const noAddr = dealIds.filter(d => !dealRaw.has(d) && !dealAddrText.has(d)).slice(0, BITRIX_ADDRESS_LIMIT);
  if (noAddr.length > 0) {
    const bx = await withTimeout(fetchDealAddresses(noAddr), 8000, new Map());
    if (bx.size > 0) addressesAvailable = true;
    for (const [dealId, a] of bx) {
      if (a.isPickup) continue;
      addRaw(dealId, a.address, a.lat, a.lon, 'bitrix');
    }
  }

  const clusters = clusterAddresses([...raws.values()].map(r => ({ key: r.key, address: r.address, lat: r.lat, lon: r.lon, weight: r.deals.size })));
  const objects = new Map<string, ModuleObject>();
  const memberOf = new Map<string, string>();         // сырой ключ → ключ объекта
  for (const c of clusters) {
    const ms = c.members.map(k => raws.get(k)!);
    const requests = ms.flatMap(m => m.requests).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    objects.set(c.key, {
      key: c.key, address: c.address, label: c.label, lat: c.lat, lon: c.lon, requests, manual: false,
      source: ms.some(m => m.source === '1c') ? '1c' : 'bitrix',
      variants: c.members.length,
    });
    for (const k of c.members) memberOf.set(k, c.key);
  }
  const dealAuto = new Map<number, string>();
  for (const [dealId, rawKey] of dealRaw) { const o = memberOf.get(rawKey); if (o) dealAuto.set(dealId, o); }

  // ── Ручные поля (sa_org/005 + 006) ───────────────────────────────────────
  let profile: ClientProfile = EMPTY_PROFILE;
  const objectProfiles: Record<string, ObjectProfile> = {};
  const dealManual = new Map<number, string>();
  let profilesAvailable = true;
  let v2Available = true;
  try {
    const p = await db.query<{ client_type: string | null; occupation: string; note: string; updated_by: string | null; updated_at: Date }>(
      `SELECT client_type, occupation, note, updated_by, updated_at FROM sa.client_module_profiles WHERE client_ref = $1`, [ref],
    );
    const pr = p.rows[0];
    if (pr) {
      profile = {
        clientType: isOneOf(CLIENT_TYPES, pr.client_type) ? pr.client_type as ClientType : null,
        occupation: pr.occupation, note: pr.note, updatedBy: pr.updated_by, updatedAt: iso(pr.updated_at),
      };
    } else {
      // Первое открытие клиента: разово подтягиваем поля из Битрикса (там ~19 тыс.
      // старых «Типов клиента») и кладём копию в sa.
      const bxp = await withTimeout(readClientFromBitrix(ref), 5000, null);
      if (bxp && (bxp.clientType || bxp.occupation || bxp.note)) {
        profile = { clientType: bxp.clientType, occupation: bxp.occupation, note: bxp.note, updatedBy: null, updatedAt: null };
        await db.query(
          `INSERT INTO sa.client_module_profiles (client_ref, client_type, client_type_enum_id, occupation, note, bitrix_synced_at)
           VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (client_ref) DO NOTHING`,
          [ref, bxp.clientType, bxp.enumId, bxp.occupation, bxp.note],
        ).catch(() => {});
      }
    }

    type ObjRow = { object_key: string; build_stage: string | null; house_type: string | null; note: string; address: string | null; lat: number | null; lon: number | null; updated_by: string | null; updated_at: Date; status_manual?: string | null; address_source?: string | null; address_confirmed?: boolean };
    let rows: ObjRow[];
    try {
      rows = (await db.query<ObjRow>(
        `SELECT object_key, build_stage, house_type, note, address, lat, lon, updated_by, updated_at, status_manual, address_source, address_confirmed
           FROM sa.client_module_objects WHERE client_ref = $1 AND NOT is_deleted`, [ref],
      )).rows;
    } catch (e) {
      if (!isMissingColumn(e)) throw e;
      v2Available = false; // миграция 006 ещё не накатана
      rows = (await db.query<ObjRow>(
        `SELECT object_key, build_stage, house_type, note, address, lat, lon, updated_by, updated_at
           FROM sa.client_module_objects WHERE client_ref = $1 AND NOT is_deleted`, [ref],
      )).rows;
    }
    // Ручные поля, сохранённые под ключом адреса, вошедшего в склеенный объект, —
    // переносим на объект (приоритет — строка под ключом самого объекта).
    rows.sort((x, y) => Number(memberOf.get(x.object_key) === x.object_key) - Number(memberOf.get(y.object_key) === y.object_key));
    for (const r of rows) {
      const lat = num(r.lat), lon = num(r.lon);
      const target = memberOf.get(r.object_key) ?? r.object_key;
      objectProfiles[target] = {
        buildStage: isOneOf(BUILD_STAGES, r.build_stage) ? r.build_stage as BuildStage : null,
        houseType: isOneOf(HOUSE_TYPES, r.house_type) ? r.house_type as HouseType : null,
        note: r.note,
        idealAddress: r.address,
        lat, lon,
        // До миграции 006: адрес, сохранённый менеджером, считаем подтверждённым.
        addressConfirmed: r.address_confirmed ?? (r.address !== null),
        doneManual: r.status_manual === 'done',
        updatedBy: r.updated_by, updatedAt: iso(r.updated_at),
      };
      // Объект, заведённый менеджером вручную (ключ 'm…').
      if (!objects.has(r.object_key) && r.object_key.startsWith('m')) {
        objects.set(r.object_key, { key: r.object_key, address: r.address ?? 'Новый объект', label: settlementLabel(r.address ?? 'Новый объект'), lat, lon, requests: [], manual: true, source: 'manual', variants: 1 });
      }
    }

    if (v2Available && dealIds.length > 0) {
      const ov = await db.query<{ deal_id: string; object_key: string }>(
        `SELECT deal_id::text AS deal_id, object_key FROM sa.client_module_deal_objects WHERE client_ref = $1`, [ref],
      ).catch(e => { if (isMissingColumn(e)) { v2Available = false; return { rows: [] }; } throw e; });
      for (const r of ov.rows) if (r.object_key) dealManual.set(Number(r.deal_id), memberOf.get(r.object_key) ?? r.object_key);
    }
  } catch (e) {
    console.warn('[clientModule] ручные поля недоступны:', e instanceof Error ? e.message : e);
    profilesAvailable = false;
    v2Available = false;
  }

  const deals: ModuleDeal[] = dealsRes.rows.map(r => {
    const products = mapProducts(r.products);
    const sums = new Map<string, number>();
    for (const p of products) if (!p.isService && p.group) sums.set(p.group, (sums.get(p.group) ?? 0) + p.sum);
    const groups = [...sums.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
    const dealId = Number(r.deal_id);
    const manual = dealManual.get(dealId);
    const objectKey = manual && objects.has(manual) ? manual : dealAuto.get(dealId) ?? null;
    const base = {
      dealId,
      name: r.deal_name,
      amount: r.amount !== null ? Math.round(Number(r.amount)) : 0,
      createdAt: iso(r.created_at),
      soldAt: iso(r.sold_at),
      deliveredAt: iso(r.delivered_at),
      lostAt: iso(r.lost_at),
      stageName: r.stage_name,
      managerName: r.manager_name,
      products,
      groups,
      topGroup: groups[0] ?? null,
      objectKey,
      objectManual: !!manual && objects.has(manual),
      // Адрес есть, но в объект не годится (только город / иностранный) — покажем в «Без объекта».
      looseAddress: objectKey ? null : (dealAddrText.get(dealId) ?? null),
    };
    return { ...base, stage: dealStage(base) };
  });

  // ── Подписи объектов: населённый пункт; два объекта в одном пункте — с улицей ──
  for (const o of objects.values()) {
    const ideal = objectProfiles[o.key]?.idealAddress;
    if (ideal) { o.address = ideal; o.label = settlementLabel(ideal); }
  }
  const byLabel = new Map<string, ModuleObject[]>();
  for (const o of objects.values()) byLabel.set(o.label, [...(byLabel.get(o.label) ?? []), o]);
  for (const [, list] of byLabel) {
    if (list.length < 2) continue;
    for (const o of list) { const d = placeDetail(o.address); if (d && d !== o.label) o.label = `${o.label} · ${d}`; }
  }

  // ── Рекомендации: клиент целиком и каждый объект ─────────────────────────
  const [matrix, priorities, settings] = await Promise.all([
    withTimeout(fetchCrossSellMatrix(), 8000, null),
    withTimeout(fetchCrossSellPriorities(), 3000, null),
    getActiveDays(),
  ]);
  // Тип дома клиента для цепочки — если на всех объектах указан один и тот же.
  const houses = new Set(Object.values(objectProfiles).map(p => p.houseType).filter(Boolean));
  const clientHouse = houses.size === 1 ? [...houses][0] as HouseType : null;
  const kind = profileKind(profile.clientType, deals);
  const byObject: Record<string, StageLadder> = {};
  for (const o of objects.values()) {
    byObject[o.key] = stageLadder(deals.filter(d => d.objectKey === o.key), objectProfiles[o.key]?.houseType ?? null, matrix, priorities, kind);
  }

  const names = await withTimeout(resolveClientNames([ref]), 4000, new Map<string, string | null>());

  return {
    ref,
    clientType: isCompany ? 'company' : 'contact',
    clientId: id,
    name: names.get(ref) ?? null,
    deals,
    objects: [...objects.values()],
    addressesAvailable,
    profile,
    objectProfiles,
    profilesAvailable,
    v2Available: v2Available && settings.available,
    activeDays: settings.days,
    profileKind: kind,
    recommendations: { client: recommendGroups(deals, clientHouse, matrix, priorities, kind), byObject },
  };
}

// ── Сохранение ────────────────────────────────────────────────────────────
// Поля клиента — СНАЧАЛА Битрикс, при успехе — копия в sa (решение владельца).
// Объекты и привязка сделок — только Монолитика (sa).

export class ProfilesNotReadyError extends Error {}
export class MirrorWriteError extends Error {}
/** Нужна миграция sa_org/006 (статус, подтверждение адреса, перепривязка, настройки). */
export class V2NotReadyError extends Error {}
export { BitrixWriteError };

function isNotReady(e: unknown): boolean {
  return e instanceof Error && /does not exist|permission denied/i.test(e.message);
}

export async function saveClientProfile(ref: ClientRef, input: { clientType: unknown; occupation: unknown; note: unknown }, by: string): Promise<void> {
  const clientType = isOneOf(CLIENT_TYPES, input.clientType) ? input.clientType : null;
  const occupation = typeof input.occupation === 'string' ? input.occupation.slice(0, 500) : '';
  const note = typeof input.note === 'string' ? input.note.slice(0, 2000) : '';

  const enumId = await writeClientToBitrix(ref, { clientType, occupation, note });
  try {
    await analyticsDb().query(
      `INSERT INTO sa.client_module_profiles (client_ref, client_type, client_type_enum_id, occupation, note, updated_by, updated_at, bitrix_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (client_ref) DO UPDATE SET client_type = EXCLUDED.client_type, client_type_enum_id = EXCLUDED.client_type_enum_id,
         occupation = EXCLUDED.occupation, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now(), bitrix_synced_at = now()`,
      [ref, clientType, enumId, occupation, note, by],
    );
  } catch (e) {
    if (isNotReady(e)) throw new ProfilesNotReadyError(e instanceof Error ? e.message : String(e));
    throw new MirrorWriteError(e instanceof Error ? e.message : String(e));
  }
}

export interface ObjectSaveInput {
  buildStage?: unknown;
  houseType?: unknown;
  note?: unknown;
  /** Адрес, поправленный менеджером (подтверждённая точка из каскада резолва). */
  ideal?: { address?: unknown; lat?: unknown; lon?: unknown } | null;
  /** «Адрес верный» — подтвердить автоматический адрес без правки. */
  confirmAddress?: unknown;
  /** true — «Завершён» вручную; false — вернуть автоматический статус. */
  done?: unknown;
}

/** Сохраняет объект; возвращает его ключ (для нового ручного объекта — созданный). */
export async function saveObjectProfile(ref: ClientRef, objectKeyIn: string, input: ObjectSaveInput, by: string): Promise<string> {
  const isNew = objectKeyIn === NEW_OBJECT_KEY;
  const objectKey = isNew ? `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : objectKeyIn.slice(0, 300);

  let idealAddress: string | null | undefined;
  let lat: number | null | undefined, lon: number | null | undefined;
  if (input.ideal) {
    const la = Number(input.ideal.lat), lo = Number(input.ideal.lon);
    if (!validLatLon(la, lo)) throw new Error('Некорректная точка адреса');
    lat = la; lon = lo;
    idealAddress = typeof input.ideal.address === 'string' ? input.ideal.address.trim().slice(0, 500) || null : null;
  }
  if (isNew && (lat == null || !idealAddress)) throw new Error('Для нового объекта нужен подтверждённый адрес');

  const db = analyticsDb();
  let prev: ObjectProfile = EMPTY_OBJECT_PROFILE;
  try {
    const r = await db.query<{ build_stage: string | null; house_type: string | null; note: string; address: string | null; lat: number | null; lon: number | null }>(
      `SELECT build_stage, house_type, note, address, lat, lon FROM sa.client_module_objects WHERE client_ref = $1 AND object_key = $2`, [ref, objectKey],
    );
    const p = r.rows[0];
    if (p) prev = { ...EMPTY_OBJECT_PROFILE, buildStage: p.build_stage as BuildStage | null, houseType: p.house_type as HouseType | null, note: p.note, idealAddress: p.address, lat: num(p.lat), lon: num(p.lon) };
  } catch (e) {
    if (isNotReady(e)) throw new ProfilesNotReadyError(e instanceof Error ? e.message : String(e));
    throw e;
  }

  // Не переданные поля не трогаем (сохраняли, например, только статус).
  const buildStage = input.buildStage === undefined ? prev.buildStage : isOneOf(BUILD_STAGES, input.buildStage) ? input.buildStage : null;
  const houseType = input.houseType === undefined ? prev.houseType : isOneOf(HOUSE_TYPES, input.houseType) ? input.houseType : null;
  const note = input.note === undefined ? prev.note : typeof input.note === 'string' ? input.note.slice(0, 2000) : '';
  const addr = idealAddress === undefined ? prev.idealAddress : idealAddress;
  const la = lat === undefined ? prev.lat : lat;
  const lo = lon === undefined ? prev.lon : lon;

  const wantsV2 = input.ideal !== undefined || input.confirmAddress !== undefined || input.done !== undefined || isNew;
  try {
    await db.query(
      `INSERT INTO sa.client_module_objects
         (client_ref, object_key, address, lat, lon, build_stage, house_type, note, is_deleted, updated_by, updated_at,
          status_manual, address_source, address_confirmed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, now(), $10, $11, $12)
       ON CONFLICT (client_ref, object_key) DO UPDATE SET address = EXCLUDED.address, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
         build_stage = EXCLUDED.build_stage, house_type = EXCLUDED.house_type, note = EXCLUDED.note, is_deleted = false,
         updated_by = EXCLUDED.updated_by, updated_at = now(),
         status_manual = CASE WHEN $13 THEN EXCLUDED.status_manual ELSE sa.client_module_objects.status_manual END,
         address_source = CASE WHEN $14 THEN EXCLUDED.address_source ELSE sa.client_module_objects.address_source END,
         address_confirmed = sa.client_module_objects.address_confirmed OR EXCLUDED.address_confirmed`,
      [ref, objectKey, addr, la, lo, buildStage, houseType, note, by,
        input.done === true ? 'done' : null,
        input.ideal ? 'manual' : null,
        !!input.ideal || input.confirmAddress === true || isNew,
        input.done !== undefined,
        !!input.ideal],
    );
  } catch (e) {
    if (!isMissingColumn(e)) {
      if (isNotReady(e)) throw new ProfilesNotReadyError(e instanceof Error ? e.message : String(e));
      throw e;
    }
    // Миграция 006 не накатана: статус/подтверждение адреса сохранить негде.
    if (input.done !== undefined || input.confirmAddress !== undefined) throw new V2NotReadyError('Нужна миграция sa_org/006');
    void wantsV2;
    await db.query(
      `INSERT INTO sa.client_module_objects (client_ref, object_key, address, lat, lon, build_stage, house_type, note, is_deleted, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, now())
       ON CONFLICT (client_ref, object_key) DO UPDATE SET address = EXCLUDED.address, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
         build_stage = EXCLUDED.build_stage, house_type = EXCLUDED.house_type, note = EXCLUDED.note, is_deleted = false,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ref, objectKey, addr, la, lo, buildStage, houseType, note, by],
    );
  }
  return objectKey;
}

/** Ручная привязка сделки к объекту; objectKey = '' — вернуть автоматическую. */
export async function saveDealObject(ref: ClientRef, dealId: number, objectKey: string, by: string): Promise<void> {
  const db = analyticsDb();
  const own = await db.query(
    `SELECT 1 FROM sa.deals d WHERE d.deal_id = $1 AND ${ref.startsWith('k') ? 'd.company_id' : 'd.contact_id'} = $2`,
    [dealId, Number(ref.slice(1))],
  );
  if (own.rowCount === 0) throw new Error('Сделка не принадлежит этому клиенту');
  try {
    await db.query(
      `INSERT INTO sa.client_module_deal_objects (deal_id, client_ref, object_key, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (deal_id) DO UPDATE SET client_ref = EXCLUDED.client_ref, object_key = EXCLUDED.object_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [dealId, ref, objectKey.slice(0, 300), by],
    );
  } catch (e) {
    if (isNotReady(e)) throw new V2NotReadyError('Нужна миграция sa_org/006');
    throw e;
  }
}
