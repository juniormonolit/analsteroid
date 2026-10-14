// Склейка адресов в объекты (правка владельца 14.10: «Поварово — это один объект,
// а адреса как минимум 2»). Чистый модуль без БД.
//
// Почему не хватало ключа адреса: у большинства адресов заявок координат НЕТ
// (sa.request_addresses: lat/lon пустые), и объект склеивался только при точном
// совпадении текста. «46Н-11388, Локомотивный микрорайон, Поварово…» и
// «46Н-11388, микрорайон Поваровка, Поварово…» — один участок, но разные строки.
//
// Как склеиваем (union-find, т.е. цепочкой: A≈B и B≈C → один объект):
//   1) оба с координатами и ближе MERGE_METERS — один объект;
//   2) иначе по тексту: убираем индекс, страну, ФО, область, муниципальные слои и
//      служебные слова; одинаковый населённый пункт + похожий набор значимых
//      слов (Жаккар ≥ TEXT_SIMILARITY) — один объект.
// Отсев: адрес вне России (иностранный мусор геокодера) и адрес «только город»
// (нет улицы/ориентира — «Санкт-Петербург, СЗФО, Россия») объектом не считаются.

export interface RawAddress {
  /** Исходный ключ (requestObjectKey) — по нему сохранены ручные поля в sa. */
  key: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  /** Сколько сделок ссылаются на этот адрес — для выбора «главного» адреса объекта. */
  weight: number;
}

export interface AddressCluster {
  /** Ключ объекта = ключ самого «тяжёлого» адреса кластера (стабилен между открытиями). */
  key: string;
  members: string[];
  address: string;
  label: string;
  lat: number | null;
  lon: number | null;
}

const MERGE_METERS = 500;
const TEXT_SIMILARITY = 0.5;

// Границы слов — явные ((?:^|\s)…(?:$|\s)): \b в JS не понимает кириллицу.
const ADMIN_PART = /(федеральный округ|^росси|област|(?:^|\s)край(?:$|\s)|республик|автономн|муниципальн|городской округ|сельское поселение|городское поселение|городской район|сельсовет|(?:^|\s)район(?:$|\s)|(?:^|\s)р-н(?:$|\s)|(?:^|\s)округ(?:$|\s)|district|schweiz|suisse)/i;
const STOP = new Set(['улица', 'ул', 'проспект', 'пр', 'пр-кт', 'микрорайон', 'мкр', 'мкрн', 'проезд', 'пр-д', 'переулок', 'пер', 'шоссе', 'ш', 'дорога', 'бульвар', 'набережная', 'площадь',
  'садоводство', 'снт', 'днп', 'тсн', 'кп', 'коттеджный', 'посёлок', 'поселок', 'пос', 'п', 'деревня', 'д', 'село', 'с', 'город', 'г', 'гп', 'пгт', 'станица', 'ст-ца', 'территория', 'тер',
  'дом', 'корпус', 'к', 'строение', 'стр', 'участок', 'уч', 'массив', 'линия', 'квартал', 'россия']);
const BIG_CITY = /^(москва|санкт-петербург|спб|г москва|г санкт-петербург)$/i;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”()]/g, ' ').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

/** Значимые части адреса в исходном порядке (без индекса, страны, админ-слоёв). */
export function addressParts(address: string): string[] {
  const parts = address.split(',').map(p => p.trim()).filter(Boolean)
    .filter(p => !/^\d{6}$/.test(p) && !ADMIN_PART.test(p));
  // Дубли вида «Всеволожск, Город Всеволожск».
  const out: string[] = [];
  for (const p of parts) {
    const core = norm(p).replace(/^(город|г|поселок|посёлок|деревня|село)\s+/, '');
    if (!out.some(o => norm(o).replace(/^(город|г|поселок|посёлок|деревня|село)\s+/, '') === core)) out.push(p);
  }
  return out;
}

function tokens(address: string): Set<string> {
  const t = new Set<string>();
  for (const p of addressParts(address)) for (const w of norm(p).split(/[\s.,;:/]+/)) if (w && !STOP.has(w) && w.length >= 2) t.add(w);
  return t;
}

/** Короткая подпись объекта: первые три значимые части. */
export function shortAddress(address: string): string {
  const parts = addressParts(address);
  return (parts.length ? parts.slice(0, 3) : [address]).join(', ');
}

// Префиксы населённых пунктов (DaData/1С пишут «г Талдом», «пгт Вербилки», «д Сярьги»).
// После префикса обязательно буква/кавычка: «д 4» — номер дома, а не деревня.
// Границы слов явные — \b в JS не работает с кириллицей.
const SETTLEMENT_PREFIX = /^(г|город|пгт|рп|п|пос|поселок|посёлок|д|дер|деревня|с|село|ст-ца|станица|х|хутор|м-в|массив|кп|снт|днп|тсн|сдт|дачный поселок)\.?\s+(?=[«"А-ЯЁа-яёA-Za-z])/i;
const KEEP_PREFIX = /^(снт|днп|тсн|сдт|кп)(?:\s|$)/i;
const REGION_FIRST = /(област|(?:^|\s)обл(?:\.|\s|$)|(?:^|\s)край(?:\s|$)|республик|(?:^|\s)респ(?:\.|\s|$)|^г\.?\s*москва$|^москва$|^г\.?\s*санкт-петербург$|^санкт-петербург$)/i;
const STREET = /(улица|(?:^|\s)ул\.?\s|проспект|пр-кт|проезд|пр-д|шоссе|переулок|пер\.|дорога|бульвар|набережная|микрорайон|мкр)/i;

/** Подпись объекта — населённый пункт (правка владельца 14.10: «Поварово»,
 *  «Богослово»). Адреса бывают в двух порядках: «мелкое → крупное» (заявки 1С,
 *  OSM: «…, микрорайон Поваровка, Поварово, городской округ…») и «крупное →
 *  мелкое» (DaData: «Московская обл, г Талдом, пгт Вербилки, ул Забырина, д 4»). */
export function settlementLabel(address: string): string {
  const raw = address.split(',').map(p => p.trim()).filter(Boolean);
  const bigFirst = raw.length > 1 && REGION_FIRST.test(raw[0]);
  const withPrefix = raw.filter(p => SETTLEMENT_PREFIX.test(p));
  const clean = (p: string) => (KEEP_PREFIX.test(p) ? p : p.replace(SETTLEMENT_PREFIX, '')).trim();
  if (withPrefix.length) {
    // Самый «мелкий» пункт: в порядке «крупное → мелкое» — последний, иначе первый.
    return clean(bigFirst ? withPrefix[withPrefix.length - 1] : withPrefix[0]);
  }
  const parts = addressParts(address);
  if (parts.length === 0) return address;
  // Без префиксов (OSM-формат «мелкое → крупное»): пункт — последняя значимая часть;
  // если это Москва/Петербург и перед ним есть район/посёлок — «Обухово (СПб)».
  const last = parts[parts.length - 1];
  if (parts.length >= 2 && BIG_CITY.test(norm(last))) {
    const prev = parts[parts.length - 2];
    if (!/\d/.test(prev) && !/(улица|проспект|проезд|шоссе|дорога|переулок)/i.test(prev)) return `${prev} (${/петербург/i.test(last) ? 'СПб' : 'Москва'})`;
    return last;
  }
  return SETTLEMENT_PREFIX.test(last) ? clean(last) : last;
}

/** Уточнение к подписи, если у клиента два объекта в одном пункте: улица/ориентир. */
export function placeDetail(address: string): string {
  const raw = address.split(',').map(p => p.trim()).filter(Boolean);
  const street = raw.find(p => STREET.test(p));
  const pick = street ?? addressParts(address).find(p => !/^\d+[а-яa-z]?$/i.test(p) && !REGION_FIRST.test(p)) ?? '';
  return pick.replace(/(^|\s)(улица|ул\.?)(\s|$)/i, ' ').trim();
}

const inRussia = (lat: number, lon: number) => lat >= 41 && lat <= 82 && (lon >= 19 || lon <= -168);

/** Адрес годится в объект? Иностранный / «только город» — нет. */
export function isUsableAddress(a: { address: string | null; lat: number | null; lon: number | null }): boolean {
  if (a.lat !== null && a.lon !== null && !inRussia(a.lat, a.lon)) return false;
  if (!a.address) return a.lat !== null && a.lon !== null;
  const cyr = (a.address.match(/[а-яё]/gi) ?? []).length, lat = (a.address.match(/[a-z]/gi) ?? []).length;
  if (lat > cyr) return false; // иностранный адрес (Швейцария и т.п.)
  if (a.lat !== null && a.lon !== null) return true;
  const parts = addressParts(a.address);
  if (parts.length === 0) return false;
  if (parts.length === 1 && (BIG_CITY.test(norm(parts[0])) || !/\d/.test(parts[0]))) return false; // только населённый пункт
  return true;
}

function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Места адреса (населённые пункты, СНТ, микрорайоны) — все значимые части,
 *  кроме первой (первая — обычно дом/дорога/ориентир). Два адреса одного места,
 *  если делят хотя бы одну такую часть: ««Волга», Богослово, Ногинск» и
 *  ««Волга», Богослово» делят «Богослово». */
const placesOf = (address: string | null): Set<string> => {
  if (!address) return new Set();
  const parts = addressParts(address).map(p => norm(p).replace(/^(город|г|поселок|посёлок|деревня|село|пгт)\s+/, ''));
  return new Set(parts.slice(1).filter(p => !/^[\d\s/-]+$/.test(p)));
};
const sharePlace = (a: Set<string>, b: Set<string>) => { for (const x of a) if (b.has(x)) return true; return false; };

export function clusterAddresses(raw: RawAddress[]): AddressCluster[] {
  const items = raw.filter(isUsableAddress);
  const n = items.length;
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const tok = items.map(i => (i.address ? tokens(i.address) : new Set<string>()));
  const place = items.map(i => placesOf(i.address));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = items[i], b = items[j];
      if (a.lat !== null && a.lon !== null && b.lat !== null && b.lon !== null) {
        if (meters(a as { lat: number; lon: number }, b as { lat: number; lon: number }) <= MERGE_METERS) union(i, j);
        continue;
      }
      // Хотя бы у одного нет координат — сравниваем текст в пределах одного населённого пункта.
      if (sharePlace(place[i], place[j]) && jaccard(tok[i], tok[j]) >= TEXT_SIMILARITY) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); }
  return [...groups.values()].map(idx => {
    const ms = idx.map(i => items[i]).sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
    const main = ms[0];
    const withCoords = ms.filter(m => m.lat !== null && m.lon !== null);
    const lat = withCoords.length ? withCoords.reduce((s, m) => s + m.lat!, 0) / withCoords.length : null;
    const lon = withCoords.length ? withCoords.reduce((s, m) => s + m.lon!, 0) / withCoords.length : null;
    const address = main.address ?? (lat !== null ? `${lat.toFixed(6)}, ${lon!.toFixed(6)}` : '');
    // Подпись — пункт, который чаще всего встречается среди написаний адреса
    // (у «Волги» один вариант с «Ногинском» не должен перебить «Богослово»).
    const votes = new Map<string, number>();
    for (const m of ms) if (m.address) { const l = settlementLabel(m.address); votes.set(l, (votes.get(l) ?? 0) + m.weight); }
    const label = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? settlementLabel(address);
    return { key: main.key, members: ms.map(m => m.key), address, label, lat, lon };
  });
}
