// Каскад резолва адреса (ТЗ владельца 13.10, «Адрес идеальный»): что бы ни
// вставили в поле — получить ТОЧНУЮ точку и честную оценку её точности.
//
//   1. Ссылка на карту  → координаты из ссылки (короткую раскрываем редиректами,
//                          только по белому списку хостов — SSRF) → точно.
//   2. Координаты       → разбор без сети → точно.
//   3. Текст            → DaData suggest по вариантам запроса (lib/geo/parse.ts
//                          queryVariants: без индекса/«Россия»/округов, порядок
//                          «область → пункт», без муниципальных слоёв) → если
//                          точность хуже улицы — запасной OSM Nominatim.
//   4. Любая точка      → обратное геокодирование: адрес, ближайший населённый
//                          пункт, район и область (одноимённые деревни в разных
//                          областях не путаем).
//
// Геокодеру на слово не верим: precision уходит в UI, и пока она хуже «дома»,
// сохранить точку можно только после ручного подтверждения на карте.
// Платных API нет: DaData — бесплатный тариф (10 тыс. запросов/сутки),
// Nominatim — публичный, не чаще 1 запроса в секунду (очередь ниже).

import { parseCoords, parseMapUrl, looksLikeUrl, toUrl, queryVariants, SHORT_LINK_HOSTS, validLatLon, type LatLon } from './parse';

export type Precision = 'pin' | 'house' | 'street' | 'settlement' | 'city' | 'region' | 'none';
export type GeoSource = 'link' | 'coords' | 'dadata' | 'osm' | 'manual';

export interface GeoCandidate {
  lat: number;
  lon: number;
  address: string;            // человекочитаемый адрес
  settlement: string | null;  // ближайший населённый пункт
  area: string | null;        // район / округ
  region: string | null;      // область / край
  precision: Precision;
  source: GeoSource;
}

export interface ResolveResult {
  kind: 'link' | 'coords' | 'text' | 'empty';
  candidates: GeoCandidate[];
  /** Почему пусто / что пошло не так — показывается менеджеру как есть. */
  note: string | null;
}

export const PRECISION_RANK: Record<Precision, number> = { pin: 0, house: 1, street: 2, settlement: 3, city: 4, region: 5, none: 6 };

// ── Кэш (в процессе): одинаковые запросы не жгут лимиты ───────────────────
const CACHE_TTL = 6 * 3600_000;
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return v;
}

// ── DaData ────────────────────────────────────────────────────────────────
interface DdSuggestion {
  value: string;
  data: {
    geo_lat: string | null; geo_lon: string | null; qc_geo: string | null;
    region_with_type: string | null; area_with_type: string | null;
    city_with_type: string | null; settlement_with_type: string | null;
    city?: string | null; settlement?: string | null; street?: string | null; house?: string | null;
    street_with_type?: string | null;
  };
}

const DD_PRECISION: Record<string, Precision> = { '0': 'house', '1': 'house', '2': 'street', '3': 'settlement', '4': 'city', '5': 'none' };

async function dadata(path: string, body: object): Promise<DdSuggestion[]> {
  const token = process.env.DADATA_TOKEN;
  if (!token) return [];
  try {
    const r = await fetch(`https://suggestions.dadata.ru/suggestions/api/4_1/rs/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.warn('[geo] DaData', path, r.status); return []; }
    const j = await r.json() as { suggestions?: DdSuggestion[] };
    return j.suggestions ?? [];
  } catch (e) {
    console.warn('[geo] DaData недоступна:', e instanceof Error ? e.message : e);
    return [];
  }
}

// ── Проверка согласованности ─────────────────────────────────────────────
// Геокодеры «дописывают» запрос: на «станица Анапская, ул. Рената Саипова, 40»
// DaData уверенно вернула ДРУГУЮ станицу (Гостагаевская, ул. Анапская), на
// «190000, г Санкт-Петербург» — случайную улицу с точностью «до улицы» (живой
// прогон 13.10). Поэтому кандидат из текста принимается, только если его
// населённый пункт, улица и дом действительно есть во введённом тексте.
// Регион и район не сверяем — их часто опускают.

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Части имени: «Рената Саипова» → оба слова должны встретиться; короткие
 *  служебные слова и типы («ул», «д», «г») не считаются. */
function mentioned(name: string | null | undefined, query: string): boolean {
  if (!name) return true;
  const words = norm(name).split(' ').filter(w => w.length >= 3 || /^\d/.test(w));
  if (words.length === 0) return true;
  const q = ` ${norm(query)} `;
  // Склонения («Плесецкой» ↔ «Плесецкая»): сравниваем по основе без 2 последних букв.
  return words.every(w => q.includes(` ${w} `) || (w.length >= 5 && q.includes(` ${w.slice(0, -2)}`)));
}

function houseMentioned(house: string | null | undefined, query: string): boolean {
  if (!house) return true;
  const h = norm(house).split(' ')[0];
  return new RegExp(`(^|\\D)${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\D|$)`).test(norm(query));
}

interface Parts { settlement?: string | null; street?: string | null; house?: string | null }
function consistent(p: Parts, query: string): boolean {
  return mentioned(p.settlement, query) && mentioned(p.street, query) && houseMentioned(p.house, query);
}

function fromDadata(s: DdSuggestion): GeoCandidate | null {
  const lat = Number(s.data.geo_lat), lon = Number(s.data.geo_lon);
  if (!s.data.geo_lat || !validLatLon(lat, lon)) return null;
  return {
    lat, lon, address: s.value,
    settlement: s.data.settlement_with_type ?? s.data.city_with_type,
    area: s.data.area_with_type,
    region: s.data.region_with_type,
    precision: DD_PRECISION[s.data.qc_geo ?? '5'] ?? 'none',
    source: 'dadata',
  };
}

// ── OSM Nominatim (запасной; публичный сервер — 1 запрос/сек) ─────────────
let nominatimChain: Promise<unknown> = Promise.resolve();
let nominatimLast = 0;
function nominatim<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const run = async (): Promise<T | null> => {
    const wait = nominatimLast + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    nominatimLast = Date.now();
    try {
      const qs = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', 'accept-language': 'ru', ...params });
      const r = await fetch(`https://nominatim.openstreetmap.org/${path}?${qs}`, {
        headers: { 'User-Agent': 'Monolitika/1.0 (monolitika.mlt-it.com; internal CRM address lookup)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { console.warn('[geo] Nominatim', path, r.status); return null; }
      return await r.json() as T;
    } catch (e) {
      console.warn('[geo] Nominatim недоступен:', e instanceof Error ? e.message : e);
      return null;
    }
  };
  const p = nominatimChain.then(run, run);
  nominatimChain = p.catch(() => null);
  return p;
}

interface NmPlace {
  lat: string; lon: string; display_name: string; addresstype?: string; type?: string;
  address?: Record<string, string>;
}

function nmPrecision(p: NmPlace): Precision {
  const t = p.addresstype ?? p.type ?? '';
  if (['house', 'building', 'house_number'].includes(t) || p.address?.house_number) return 'house';
  if (['road', 'street', 'pedestrian', 'residential'].includes(t)) return 'street';
  if (['village', 'hamlet', 'isolated_dwelling', 'town', 'suburb', 'neighbourhood', 'quarter', 'allotments', 'farm', 'locality'].includes(t)) return 'settlement';
  if (t === 'city') return 'city';
  if (['state', 'county', 'region', 'municipality', 'district'].includes(t)) return 'region';
  return 'settlement';
}

function fromNominatim(p: NmPlace): GeoCandidate | null {
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!validLatLon(lat, lon)) return null;
  const a = p.address ?? {};
  const settlement = a.village ?? a.hamlet ?? a.town ?? a.city ?? a.isolated_dwelling ?? a.allotments ?? a.suburb ?? null;
  // СНТ/КП (allotments / residential) — в адрес между пунктом и улицей.
  const territory = a.allotments && a.allotments !== settlement ? a.allotments : a.residential ?? null;
  const street = [a.road, a.house_number].filter(Boolean).join(', ');
  const address = [a.state, a.county, settlement, territory, street].filter(Boolean).join(', ') || p.display_name;
  return { lat, lon, address, settlement, area: a.county ?? a.municipality ?? null, region: a.state ?? null, precision: nmPrecision(p), source: 'osm' };
}

// ── Обратное геокодирование ────────────────────────────────────────────────

/** Что находится в точке: адрес, населённый пункт, район, область. Точность —
 *  'pin' (точка задана человеком/ссылкой), адрес — справочный, «ближайший».
 *
 *  Правка 19.10 (владелец: «по координатам из Яндекса подпись «округ Чехов»
 *  вместо «КП Лесная поляна»»). Замер на 90 заявках 1С, где в комментарии есть
 *  и точка, и название СНТ/КП: «сначала DaData, иначе OSM» попадал в название
 *  в 46%, новое правило — в 61% (часть промахов — шум самого эталона):
 *   • DaData отдаёт БЛИЖАЙШИЙ дом из ФИАС в радиусе 1 км — в КП домов в ФИАС
 *     нет, и «побеждает» дом соседней деревни. Её ответ берём, только если
 *     найденный дом ≤ 300 м от точки;
 *   • название территории (СНТ/КП/ДНП — у DaData «тер. …», у OSM allotments /
 *     residential) важнее деревни: если DaData его не называет, а OSM — да,
 *     берём OSM. */
const NEAR_HOUSE_M = 300;
const TERRITORY = /(^|[\s.])(тер|снт|днп|днт|тсн|кп|дп|ст|жк|дск|массив)([\s.]|$)/i;

function distM(a: LatLon, b: LatLon): number {
  const R = 6371000, t = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * t / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin((b.lon - a.lon) * t / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function reverseGeocode(pt: LatLon, source: GeoSource = 'manual'): Promise<GeoCandidate> {
  const key = `rev2:${pt.lat.toFixed(5)},${pt.lon.toFixed(5)}`;
  const base = await cached(key, async () => {
    const [dd, nm] = await Promise.all([
      dadata('geolocate/address', { lat: pt.lat, lon: pt.lon, count: 1, radius_meters: 1000 }),
      nominatim<NmPlace>('reverse', { lat: String(pt.lat), lon: String(pt.lon), zoom: '18', addressdetails: '1' }),
    ]);
    const d = dd[0] ? fromDadata(dd[0]) : null;
    const dNear = d && distM(pt, d) <= NEAR_HOUSE_M ? d : null;
    const dTerr = dd[0]?.data.street_with_type && TERRITORY.test(dd[0].data.street_with_type) ? dd[0].data.street_with_type : null;
    const n = nm ? fromNominatim(nm) : null;
    const nTerr = nm?.address ? (nm.address.allotments ?? nm.address.residential ?? null) : null;

    if (dNear && (dTerr || !nTerr)) {
      return { address: dNear.address, settlement: dTerr ?? dNear.settlement, area: dNear.area, region: dNear.region };
    }
    if (n) return { address: n.address, settlement: nTerr ?? n.settlement, area: n.area, region: n.region };
    // Только дальний дом DaData — его населённый пункт как ориентир, без улицы и дома.
    if (d) return { address: [d.region, d.area, d.settlement].filter(Boolean).join(', ') || d.address, settlement: d.settlement, area: d.area, region: d.region };
    return { address: `${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)}`, settlement: null, area: null, region: null };
  });
  return { lat: pt.lat, lon: pt.lon, ...base, precision: 'pin', source };
}

// ── Короткие ссылки ────────────────────────────────────────────────────────

/** Проходит редиректы короткой ссылки (только белый список хостов на КАЖДОМ
 *  шаге) и возвращает итоговый URL. Тело страниц не читаем. */
async function expandShortLink(input: string): Promise<string | null> {
  let url = toUrl(input);
  for (let hop = 0; url && hop < 6; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!SHORT_LINK_HOSTS.test(url.hostname)) return null;
    if (parseMapUrl(url.href)) return url.href;
    try {
      const r = await fetch(url.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0 (Monolitika address lookup)' } });
      const loc = r.headers.get('location');
      if (!loc || r.status < 300 || r.status >= 400) return url.href;
      url = new URL(loc, url);
    } catch {
      return null;
    }
  }
  return url?.href ?? null;
}

// ── Подсказки при наборе ───────────────────────────────────────────────────

export async function suggestAddress(q: string): Promise<GeoCandidate[]> {
  const query = q.trim();
  if (query.length < 3) return [];
  return cached(`sug:${query.toLowerCase()}`, async () => {
    // Подсказки при наборе — без сверки: человек сам выбирает из списка.
    const dd = await dadata('suggest/address', { query, count: 7 });
    return dd.map(fromDadata).filter((c): c is GeoCandidate => !!c);
  });
}

// ── Главный вход ──────────────────────────────────────────────────────────

function dedupe(cs: GeoCandidate[]): GeoCandidate[] {
  const seen = new Set<string>();
  return cs.filter(c => {
    const k = `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

export async function resolveAddressInput(input: string): Promise<ResolveResult> {
  const s = input.trim().slice(0, 500);
  if (!s) return { kind: 'empty', candidates: [], note: null };

  // 1. Ссылка на карту.
  if (looksLikeUrl(s)) {
    let parsed = parseMapUrl(s);
    if (!parsed) {
      const expanded = await expandShortLink(s);
      parsed = expanded ? parseMapUrl(expanded) : null;
      if (!parsed) {
        return {
          kind: 'link', candidates: [],
          note: expanded
            ? 'В ссылке нет координат (например, это ссылка на организацию). Откройте точку на карте и скопируйте ссылку на неё или координаты.'
            : 'Эту ссылку разобрать не удалось. Поддерживаются Яндекс Карты, Google Maps, 2ГИС, OpenStreetMap, Apple Maps.',
        };
      }
    }
    return { kind: 'link', candidates: [await reverseGeocode(parsed.point, 'link')], note: null };
  }

  // 2. Координаты.
  const pt = parseCoords(s);
  if (pt) return { kind: 'coords', candidates: [await reverseGeocode(pt, 'coords')], note: null };

  // 3. Текст: DaData по вариантам запроса, пока не найдём хотя бы улицу.
  return cached(`res:${s.toLowerCase()}`, async () => {
    const found: GeoCandidate[] = [];
    for (const v of queryVariants(s)) {
      const dd = await dadata('suggest/address', { query: v, count: 5 });
      found.push(...dd
        .filter(d => consistent({ settlement: d.data.settlement ?? d.data.city, street: d.data.street, house: d.data.house }, s))
        .map(fromDadata).filter((c): c is GeoCandidate => !!c));
      const best = Math.min(...found.map(c => PRECISION_RANK[c.precision]), 99);
      if (best <= PRECISION_RANK.street) break;
    }
    // Хуже улицы (или DaData пусто) — спрашиваем OpenStreetMap.
    const best = Math.min(...found.map(c => PRECISION_RANK[c.precision]), 99);
    if (best > PRECISION_RANK.street) {
      const variants = queryVariants(s);
      for (const v of variants.slice(0, 2)) {
        const nm = await nominatim<NmPlace[]>('search', { q: v, countrycodes: 'ru', limit: '5' });
        const cs = (nm ?? [])
          .filter(p => { const a = p.address ?? {}; return consistent({ settlement: a.village ?? a.hamlet ?? a.town ?? a.city, street: a.road, house: a.house_number }, s); })
          .map(fromNominatim).filter((c): c is GeoCandidate => !!c);
        found.push(...cs);
        if (cs.length) break;
      }
    }
    const candidates = dedupe(found).sort((a, b) => PRECISION_RANK[a.precision] - PRECISION_RANK[b.precision]).slice(0, 6);
    return {
      kind: 'text' as const,
      candidates,
      note: candidates.length === 0
        ? 'Адрес не найден ни в DaData, ни в OpenStreetMap. Вставьте ссылку на точку в картах или координаты — это всегда точно.'
        : null,
    };
  });
}
