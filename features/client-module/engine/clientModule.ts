import { analyticsDb } from '@/lib/db/clients';
import { resolveClientNames } from '@/lib/bitrix/clientNames';
import {
  type ClientRef, type ClientModuleData, type ModuleDeal, type ModuleObject, type ModuleProduct,
  type ClientProfile, type ObjectProfile, type ClientType, type BuildStage, type HouseType,
  CLIENT_TYPES, BUILD_STAGES, HOUSE_TYPES, EMPTY_PROFILE, requestObjectKey,
} from './types';

// Модуль «Карточка клиента» (ТЗ владельца 13.10): данные для виджета, который
// потом встанет в карточку контакта/компании Битрикса. Пока живёт в «Ещё →
// Модули» как превью для админов.
//
// Клиент — то, по чему открыли (решение владельца 13.10):
//   contactId → ВСЕ сделки с этим contact_id (и физ., и юр.), воронки 0–3;
//   companyId → все сделки компании.
// Это сознательно НЕ сегментация «Моих заказчиков» (CLIENT_KEY_CASE_SQL): виджет
// стоит в карточке конкретной сущности Битрикса и показывает её сделки целиком.
//
// Объекты — адреса заявок из sa.request_addresses (view над заявками Пульта и
// связью заявка → сделка; bitrix_id = ID сделки). Адреса сделок из Битрикса
// (deal_addresses в system) здесь НЕ используются — решение владельца 13.10.

const NON_GOODS_RE = /^(доставка|перевозка|услуг|разное)/i;

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
      ORDER BY coalesce(d.delivered_at, d.sold_at, d.created_at) ASC, d.deal_id ASC
      LIMIT 3000`,
    [id],
  );

  // ── Объекты: адреса заявок по сделкам клиента ──────────────────────────
  const dealIds = dealsRes.rows.map(r => Number(r.deal_id));
  const objects = new Map<string, ModuleObject>();
  const dealObjects = new Map<number, Set<string>>();
  let addressesAvailable = true;
  if (dealIds.length > 0) {
    try {
      const addr = await db.query<{ bitrix_id: string; request_number: string | null; request_date: Date | string | null; address: string | null; lat: number | string | null; lon: number | string | null }>(
        `SELECT bitrix_id::text AS bitrix_id, request_number, request_date, address, lat, lon
           FROM sa.request_addresses
          WHERE bitrix_id = ANY($1::bigint[])
          ORDER BY request_date ASC NULLS LAST`,
        [dealIds],
      );
      for (const r of addr.rows) {
        const lat = r.lat !== null ? Number(r.lat) : null;
        const lon = r.lon !== null ? Number(r.lon) : null;
        const okLat = lat !== null && Number.isFinite(lat) ? lat : null;
        const okLon = lon !== null && Number.isFinite(lon) ? lon : null;
        const address = (r.address ?? '').trim() || null;
        const key = requestObjectKey(address, okLat, okLon);
        if (!key) continue;
        const obj = objects.get(key) ?? { key, address: address ?? `${okLat}, ${okLon}`, lat: okLat, lon: okLon, requests: [] };
        // Самый свежий адрес объекта — как подпись (строки пишут по-разному).
        if (address) obj.address = address;
        if (obj.lat === null && okLat !== null) { obj.lat = okLat; obj.lon = okLon; }
        if (r.request_number) obj.requests.push({ number: r.request_number, date: iso(r.request_date) });
        objects.set(key, obj);
        const dId = Number(r.bitrix_id);
        const set = dealObjects.get(dId) ?? new Set<string>();
        set.add(key);
        dealObjects.set(dId, set);
      }
    } catch (e) {
      addressesAvailable = false;
      console.warn('[clientModule] sa.request_addresses недоступна:', e instanceof Error ? e.message : e);
    }
  }

  const deals: ModuleDeal[] = dealsRes.rows.map(r => {
    const products = mapProducts(r.products);
    const groups = [...new Set(products.filter(p => !p.isService && p.group).map(p => p.group!))];
    return {
      dealId: Number(r.deal_id),
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
      objectKeys: [...(dealObjects.get(Number(r.deal_id)) ?? [])],
    };
  });

  // ── Ручные поля (sa_org/005) ────────────────────────────────────────────
  let profile: ClientProfile = EMPTY_PROFILE;
  const objectProfiles: Record<string, ObjectProfile> = {};
  let profilesAvailable = true;
  try {
    const [p, o] = await Promise.all([
      db.query<{ client_type: string | null; occupation: string; note: string; updated_by: string | null; updated_at: Date }>(
        `SELECT client_type, occupation, note, updated_by, updated_at FROM sa.client_module_profiles WHERE client_ref = $1`, [ref],
      ),
      db.query<{ object_key: string; build_stage: string | null; house_type: string | null; note: string; updated_by: string | null; updated_at: Date }>(
        `SELECT object_key, build_stage, house_type, note, updated_by, updated_at FROM sa.client_module_objects WHERE client_ref = $1`, [ref],
      ),
    ]);
    const pr = p.rows[0];
    if (pr) profile = {
      clientType: isOneOf(CLIENT_TYPES, pr.client_type) ? pr.client_type as ClientType : null,
      occupation: pr.occupation, note: pr.note, updatedBy: pr.updated_by, updatedAt: iso(pr.updated_at),
    };
    for (const r of o.rows) objectProfiles[r.object_key] = {
      buildStage: isOneOf(BUILD_STAGES, r.build_stage) ? r.build_stage as BuildStage : null,
      houseType: isOneOf(HOUSE_TYPES, r.house_type) ? r.house_type as HouseType : null,
      note: r.note, updatedBy: r.updated_by, updatedAt: iso(r.updated_at),
    };
  } catch {
    profilesAvailable = false; // миграция sa_org/005 ещё не накатана
  }

  // Имя — кэш client_names (system) + добор из Битрикса; system бывает
  // недоступна — модуль не должен из-за этого падать или висеть.
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
  };
}

// ── Сохранение ручных полей ───────────────────────────────────────────────

export class ProfilesNotReadyError extends Error {}

export async function saveClientProfile(ref: ClientRef, input: { clientType: unknown; occupation: unknown; note: unknown }, by: string): Promise<void> {
  const clientType = isOneOf(CLIENT_TYPES, input.clientType) ? input.clientType : null;
  const occupation = typeof input.occupation === 'string' ? input.occupation.slice(0, 500) : '';
  const note = typeof input.note === 'string' ? input.note.slice(0, 2000) : '';
  try {
    await analyticsDb().query(
      `INSERT INTO sa.client_module_profiles (client_ref, client_type, occupation, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (client_ref) DO UPDATE SET client_type = EXCLUDED.client_type, occupation = EXCLUDED.occupation,
         note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ref, clientType, occupation, note, by],
    );
  } catch (e) {
    if (e instanceof Error && /does not exist|permission denied/i.test(e.message)) throw new ProfilesNotReadyError(e.message);
    throw e;
  }
}

export async function saveObjectProfile(ref: ClientRef, objectKey: string, input: { buildStage: unknown; houseType: unknown; note: unknown }, by: string): Promise<void> {
  const buildStage = isOneOf(BUILD_STAGES, input.buildStage) ? input.buildStage : null;
  const houseType = isOneOf(HOUSE_TYPES, input.houseType) ? input.houseType : null;
  const note = typeof input.note === 'string' ? input.note.slice(0, 2000) : '';
  try {
    await analyticsDb().query(
      `INSERT INTO sa.client_module_objects (client_ref, object_key, build_stage, house_type, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (client_ref, object_key) DO UPDATE SET build_stage = EXCLUDED.build_stage, house_type = EXCLUDED.house_type,
         note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ref, objectKey.slice(0, 300), buildStage, houseType, note, by],
    );
  } catch (e) {
    if (e instanceof Error && /does not exist|permission denied/i.test(e.message)) throw new ProfilesNotReadyError(e.message);
    throw e;
  }
}
