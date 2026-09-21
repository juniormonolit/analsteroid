// Адреса объектов сделок (задача владельца 21.09: «Давай быстро запрашивать при
// заходе в карточку сделки или заказчика в списке сделок, чтобы было видно по
// его объектам»).
//
// Источник — поле сделки UF_ADDRESS_COORDS в Битриксе (разведка 21.09: 489 из
// 500 последних закрытых сделок, 98%). Формат значения:
//   «155020, Ивановская обл, Гаврилово-Посадский р-н, поселок Петровский||56.645326,40.317863»
// до «||» — адрес строкой, после — широта,долгота. Иногда координат нет вовсе
// («Выборг») — это валидный адрес без точки на карте.
//
// В sa.deals адреса НЕТ (синк его не тянет), у компаний и контактов адресные
// поля пустые — единственный источник Битрикс. Поэтому свой кэш deal_addresses
// (миграция 216): ленивое дозаполнение на открытие карточки + фоновый бэкфилл
// всей базы. Промах кэша тоже штампуется (found=false) — иначе сделка без
// адреса дёргала бы Битрикс на каждый показ.

import { systemDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { bx } from '@/lib/bitrix/notify';
import { parseAddressCoords, objectKey, isPickupAddress } from './addressUtils';

// Разбор формата и ключ «объекта» — в отдельном модуле без импорта БД:
// их дёргает и клиентский код (карточка заказчика считает объекты).
export { parseAddressCoords, objectKey, isPickupAddress } from './addressUtils';

export interface DealAddress {
  dealId: number;
  address: string | null;
  lat: number | null;
  lon: number | null;
  regionId: string | null;
  /** «Париж» в адресе = самовывоз: адреса доставки у сделки физически нет
   *  (правило владельца 21.09, миграция 219). */
  isPickup?: boolean;
  /** Привязка сделки к заказчику — кладём рядом, чтобы «объекты клиента» и
   *  карта считались без кросс-базного джойна с sa.deals (миграция 217). */
  companyId?: number | null;
  contactId?: number | null;
  categoryId?: number | null;
}

/** Сколько живёт запись до повторного спроса Битрикса: адрес объекта правят
 *  редко, но правят (уточняют посёлок, переносят объект). */
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Промах (адреса нет) перепроверяем чаще: у активной сделки его могут заполнить. */
const MISS_TTL_MS = 2 * 24 * 60 * 60 * 1000;
/** Битрикс отдаёт до 50 записей на команду и до 50 команд в batch. */
const PAGE = 50;
const BATCH_CMDS = 50;

interface BxDeal {
  ID: string; UF_ADDRESS_COORDS?: string | null; UF_REGION?: string | null;
  COMPANY_ID?: string | null; CONTACT_ID?: string | null; CATEGORY_ID?: string | null;
}

function rowToAddress(r: { deal_id: string | number; address: string | null; lat: number | null; lon: number | null; region_id: string | null; is_pickup?: boolean }): DealAddress {
  return {
    dealId: Number(r.deal_id), address: r.address, lat: r.lat, lon: r.lon, regionId: r.region_id,
    isPickup: r.is_pickup ?? isPickupAddress(r.address),
  };
}

async function readCache(dealIds: number[]): Promise<{ fresh: Map<number, DealAddress>; staleOrMissing: number[] }> {
  const fresh = new Map<number, DealAddress>();
  const known = new Set<number>();
  const res = await systemDb().query<{
    deal_id: string; address: string | null; lat: number | null; lon: number | null; region_id: string | null;
    fetched_at: Date; found: boolean; is_pickup: boolean;
  }>(`SELECT deal_id, address, lat, lon, region_id, is_pickup, fetched_at, found FROM deal_addresses WHERE deal_id = ANY($1::bigint[])`, [dealIds]);
  const now = Date.now();
  for (const r of res.rows) {
    const id = Number(r.deal_id);
    const age = now - new Date(r.fetched_at).getTime();
    if (age < (r.found ? TTL_MS : MISS_TTL_MS)) {
      known.add(id);
      if (r.found) fresh.set(id, rowToAddress(r));
      else fresh.set(id, { dealId: id, address: null, lat: null, lon: null, regionId: r.region_id, isPickup: false });
    }
  }
  return { fresh, staleOrMissing: dealIds.filter(id => !known.has(id)) };
}

async function upsert(rows: DealAddress[], found: boolean[]): Promise<void> {
  if (rows.length === 0) return;
  await systemDb().query(
    `INSERT INTO deal_addresses (deal_id, address, lat, lon, raw, region_id, company_id, contact_id, category_id, fetched_at, found)
     SELECT * FROM unnest($1::bigint[], $2::text[], $3::float8[], $4::float8[], $5::text[], $6::text[],
                          $7::bigint[], $8::bigint[], $9::int[],
                          array_fill(now(), ARRAY[array_length($1::bigint[], 1)]), $10::boolean[])
     ON CONFLICT (deal_id) DO UPDATE
       SET address = EXCLUDED.address, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
           raw = EXCLUDED.raw, region_id = EXCLUDED.region_id,
           company_id = EXCLUDED.company_id, contact_id = EXCLUDED.contact_id, category_id = EXCLUDED.category_id,
           fetched_at = now(), found = EXCLUDED.found`,
    [
      rows.map(r => r.dealId),
      rows.map(r => r.address),
      rows.map(r => r.lat),
      rows.map(r => r.lon),
      rows.map(r => (r.address ?? null)),
      rows.map(r => r.regionId),
      rows.map(r => r.companyId ?? null),
      rows.map(r => r.contactId ?? null),
      rows.map(r => r.categoryId ?? null),
      found,
    ],
  );
}

const num = (v: string | null | undefined): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toAddress(d: BxDeal): { row: DealAddress; found: boolean } {
  const parsed = parseAddressCoords(d.UF_ADDRESS_COORDS);
  return {
    row: {
      dealId: Number(d.ID), address: parsed.address, lat: parsed.lat, lon: parsed.lon,
      regionId: d.UF_REGION ?? null, isPickup: isPickupAddress(parsed.address),
      companyId: num(d.COMPANY_ID), contactId: num(d.CONTACT_ID), categoryId: num(d.CATEGORY_ID),
    },
    found: parsed.address !== null,
  };
}

const SELECT_FIELDS = ['ID', 'UF_ADDRESS_COORDS', 'UF_REGION', 'COMPANY_ID', 'CONTACT_ID', 'CATEGORY_ID'];

/**
 * Адреса конкретных сделок: свежее — из кэша, остальное спрашиваем у Битрикса
 * (батчами по 50 id) и складываем в кэш. Битрикс недоступен — отдаём, что есть
 * в кэше, пусть и протухшее: карточка не должна падать из-за адреса.
 */
export async function fetchDealAddresses(dealIds: number[]): Promise<Map<number, DealAddress>> {
  const ids = [...new Set(dealIds.filter(id => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return new Map();

  let fresh: Map<number, DealAddress>;
  let missing: number[];
  try {
    const cache = await readCache(ids);
    fresh = cache.fresh;
    missing = cache.staleOrMissing;
  } catch {
    fresh = new Map();
    missing = ids;    // таблицы ещё нет на этом инстансе — спросим Битрикс напрямую
  }
  if (missing.length === 0) return fresh;

  const webhook = process.env.BITRIX_WEBHOOK_URL || '';
  if (!webhook) return fresh;

  try {
    for (let i = 0; i < missing.length; i += PAGE) {
      const chunk = missing.slice(i, i + PAGE);
      const body = await bx(webhook, 'crm.deal.list', {
        filter: { '@ID': chunk }, select: SELECT_FIELDS, start: -1,
      });
      const got = (body?.result ?? []) as BxDeal[];
      const parsed = got.map(toAddress);
      // Сделки, которых Битрикс не вернул (удалена/нет доступа), тоже помечаем
      // промахом — иначе будем спрашивать про них при каждом открытии.
      const seen = new Set(parsed.map(p => p.row.dealId));
      for (const id of chunk) {
        if (!seen.has(id)) parsed.push({ row: { dealId: id, address: null, lat: null, lon: null, regionId: null }, found: false });
      }
      await upsert(parsed.map(p => p.row), parsed.map(p => p.found)).catch(() => {});
      for (const p of parsed) fresh.set(p.row.dealId, p.row);
    }
  } catch (e) {
    console.warn('[dealAddress] Битрикс не ответил:', e instanceof Error ? e.message : e);
  }
  return fresh;
}

/** Только кэш, без похода в Битрикс — для массовых мест (карта, признак «строитель»). */
export async function getCachedDealAddresses(dealIds: number[]): Promise<Map<number, DealAddress>> {
  const ids = [...new Set(dealIds.filter(id => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return new Map();
  const out = new Map<number, DealAddress>();
  try {
    const res = await systemDb().query<{ deal_id: string; address: string | null; lat: number | null; lon: number | null; region_id: string | null; is_pickup: boolean }>(
      `SELECT deal_id, address, lat, lon, region_id, is_pickup FROM deal_addresses WHERE deal_id = ANY($1::bigint[]) AND found`, [ids],
    );
    for (const r of res.rows) out.set(Number(r.deal_id), rowToAddress(r));
  } catch { /* таблицы нет — пустая карта, вызывающий это переживает */ }
  return out;
}

export interface BackfillStats { scanned: number; withAddress: number; lastId: number; batches: number; ms: number; polite: boolean }

// ── Режим вежливости к Битриксу (правка владельца 21.09, дословно: «Как
// минимум, делай батчами и в супервежливом режиме до 20:00, с 20:00 до 07:00
// можно по полной хуярить») ──────────────────────────────────────────────────
// Днём портал работает под живой нагрузкой менеджеров — бэкфилл идёт мелкими
// порциями с паузами. Ночью (20:00–07:00 МСК) — полная скорость.
// Точечные запросы при открытии карточки (fetchDealAddresses, ≤50 id) под это
// правило не попадают: это работа менеджера, а не фоновый обход.

export function isPoliteHours(now = new Date()): boolean {
  const mskHour = Number(new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', hour12: false, timeZone: 'Europe/Moscow' }).format(now));
  return mskHour >= 7 && mskHour < 20;
}

export interface BackfillPlan {
  /** Сколько команд crm.deal.list класть в один batch (каждая — 50 сделок). */
  cmds: number;
  /** Пауза между batch-запросами. */
  pauseMs: number;
  /** Сколько batch-запросов за один вызов (тик планировщика). */
  maxBatches: number;
}

/** План обхода на текущий час: днём — по 500 сделок с паузой, ночью — полный ход. */
export function backfillPlan(now = new Date()): BackfillPlan {
  return isPoliteHours(now)
    ? { cmds: 10, pauseMs: 3000, maxBatches: 4 }     // ~2 тыс. сделок за тик, 4 запроса с паузами
    : { cmds: BATCH_CMDS, pauseMs: 200, maxBatches: 20 };  // ~50 тыс. сделок за тик
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Фоновый бэкфилл: проход по всем сделкам Битрикса ID-пагинацией. Внутри batch
 * следующая команда берёт «>ID» из последней строки предыдущей
 * (`$result[cN][49][ID]`) — 2500 сделок за один HTTP-запрос и ~0,5 с против
 * 35 с у обычного start-офсета (замер 21.09 на 254 тыс. сделок).
 *
 * `fromId` — с какого ID продолжать (0 = сначала). Размер порции, паузы и
 * потолок за вызов берутся из backfillPlan() — днём это 4 запроса по 500
 * сделок с паузой 3 с, ночью полный ход (см. режим вежливости выше); любое
 * поле можно перебить аргументом `plan`.
 */
export async function backfillDealAddresses(fromId = 0, plan: Partial<BackfillPlan> = {}): Promise<BackfillStats> {
  const webhook = process.env.BITRIX_WEBHOOK_URL || '';
  const p = { ...backfillPlan(), ...plan };
  const t0 = Date.now();
  const stats: BackfillStats = { scanned: 0, withAddress: 0, lastId: fromId, batches: 0, ms: 0, polite: isPoliteHours() };
  if (!webhook) return stats;

  for (let b = 0; b < p.maxBatches; b++) {
    if (b > 0 && p.pauseMs > 0) await sleep(p.pauseMs);
    const cmd: Record<string, string> = {};
    for (let i = 0; i < p.cmds; i++) {
      const idExpr = i === 0 ? String(stats.lastId) : `$result[c${i - 1}][${PAGE - 1}][ID]`;
      const qs = new URLSearchParams({ 'order[ID]': 'ASC', 'filter[>ID]': idExpr, start: '-1' });
      SELECT_FIELDS.forEach((f, n) => qs.append(`select[${n}]`, f));
      cmd[`c${i}`] = `crm.deal.list?${qs}`;
    }
    const body = await bx(webhook, 'batch', { halt: 0, cmd });
    const parts = (body?.result?.result ?? {}) as Record<string, BxDeal[]>;
    const deals = Object.values(parts).flat();
    if (deals.length === 0) { stats.lastId = 0; break; }   // дошли до конца — следующий проход с начала

    const parsed = deals.map(toAddress);
    await upsert(parsed.map(p => p.row), parsed.map(p => p.found));
    stats.scanned += parsed.length;
    stats.withAddress += parsed.filter(p => p.found).length;
    stats.lastId = Math.max(...parsed.map(p => p.row.dealId));
    stats.batches++;
    if (deals.length < p.cmds * PAGE) { stats.lastId = 0; break; }  // последняя страница
  }
  stats.ms = Date.now() - t0;
  return stats;
}

/** Сколько адресов уже в кэше — для страницы настроек и логов бэкфилла. */
export async function dealAddressStats(): Promise<{ rows: number; withAddress: number; withCoords: number; maxDealId: number; oldestFetchedAt: string | null }> {
  const res = await systemDb().query<{ rows: string; with_address: string; with_coords: string; max_deal_id: string | null; oldest: Date | null }>(
    `SELECT count(*)::text AS rows,
            count(*) FILTER (WHERE found)::text AS with_address,
            count(*) FILTER (WHERE lat IS NOT NULL)::text AS with_coords,
            max(deal_id)::text AS max_deal_id,
            min(fetched_at) AS oldest
       FROM deal_addresses`,
  );
  const r = res.rows[0]!;
  return {
    rows: Number(r.rows), withAddress: Number(r.with_address), withCoords: Number(r.with_coords),
    maxDealId: Number(r.max_deal_id ?? 0),
    oldestFetchedAt: r.oldest ? new Date(r.oldest).toISOString() : null,
  };
}

/**
 * Сколько РАЗНЫХ объектов у заказчика (задача владельца 21.09: «хочу, чтобы
 * заказчики ещё классифицировались как потенциальные строители, если сделки на
 * разные адреса»). Считается целиком в системной БД по сохранённым при
 * бэкфилле company_id/contact_id/category_id — без похода в Битрикс и без
 * кросс-базного джойна с sa.deals.
 *
 * Замер 21.09 по всей базе: из 14 527 заказчиков с 2+ сделками с адресом
 * 1 777 (12%) возят на 2+ разных объекта, 231 — на 3+. То есть признак
 * выделяет реальный сегмент, а не «почти всех» и не единицы.
 */
export async function fetchClientObjectCounts(clientKeys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keys = [...new Set(clientKeys.filter(Boolean))];
  if (keys.length === 0) return out;
  try {
    const res = await systemDb().query<{ client_key: string; objs: string }>(
      `WITH hot AS (
         SELECT obj_key FROM deal_addresses
          WHERE found AND obj_key IS NOT NULL
          GROUP BY 1 HAVING count(*) >= $2
       )
       SELECT client_key, count(DISTINCT obj_key)::text AS objs
         FROM deal_addresses d
        WHERE found AND obj_key IS NOT NULL AND client_key = ANY($1::text[])
          AND NOT is_pickup                                   -- самовывоз не объект (правило владельца 21.09)
          AND NOT EXISTS (SELECT 1 FROM hot WHERE hot.obj_key = d.obj_key)
        GROUP BY 1`,
      [keys, HOT_OBJECT_MIN_DEALS],
    );
    for (const r of res.rows) out.set(r.client_key, Number(r.objs));
  } catch { /* таблицы нет — признак просто не показывается */ }
  return out;
}

/**
 * «Служебные» точки: адреса, на которые по всей базе приходятся сотни сделок —
 * это не объекты, а дефолты Битрикса и «просто город». Замер 21.09: 32 таких
 * obj_key собрали 75 265 сделок из 236 809 (32%!) — крупнейшая тянет 23 593
 * («ул Вице-адмирала Падорина, д 31» в Североморске — явный дефолт формы),
 * дальше центр Петербурга (8 350), Красная площадь (4 251), «г Москва» (3 704).
 * Их нельзя считать ни объектами клиента (иначе «строителей» 1 777 вместо
 * честных 1 358), ни точками карты — на карте они по умолчанию скрыты.
 */
export const HOT_OBJECT_MIN_DEALS = 300;

/** Набор служебных obj_key (кэш на час — состав меняется медленно). */
export async function hotObjectKeys(): Promise<Set<string>> {
  try {
    const rows = await cached('deal-addresses:hot-objects:v1', 60 * 60, async () => {
      const res = await systemDb().query<{ obj_key: string }>(
        `SELECT obj_key FROM deal_addresses
          WHERE found AND obj_key IS NOT NULL
          GROUP BY 1 HAVING count(*) >= $1`, [HOT_OBJECT_MIN_DEALS],
      );
      return res.rows.map(r => r.obj_key);
    });
    return new Set(rows);
  } catch {
    return new Set();
  }
}

/** Порог «возит на разные объекты» — потенциальный строитель. */
export const BUILDER_MIN_OBJECTS = 2;
