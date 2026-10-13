// Разбор «чего угодно» в поле адреса (ТЗ владельца 13.10, «Адрес идеальный»):
// ссылка на карту или координаты → точка БЕЗ всякого геокодера, точно до метра.
// Модуль без сети и БД — его зовут и сервер (lib/geo/resolve.ts), и клиент
// (мгновенная реакция на вставку ссылки/координат в поле).
//
// Порядок координат у провайдеров разный, поэтому каждый разбирается отдельно:
//   Яндекс  — ll / pt / whatshere[point] = «ДОЛГОТА,ШИРОТА»;
//   Google  — /@ш,д  и  !3dШ!4dД (точка места — точнее центра экрана), q=ш,д;
//   2ГИС    — m=Д,Ш/zoom, /geo/Д,Ш;
//   OSM     — mlat/mlon, #map=z/ш/д;
//   Apple   — ll=ш,д, q=ш,д, coordinate=ш,д.

export interface LatLon { lat: number; lon: number }

const num = (s: string) => Number(s.replace(',', '.'));

export function validLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

function pair(a: string | null | undefined, order: 'latlon' | 'lonlat'): LatLon | null {
  if (!a) return null;
  const m = a.match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const x = Number(m[1]), y = Number(m[2]);
  const p = order === 'latlon' ? { lat: x, lon: y } : { lat: y, lon: x };
  return validLatLon(p.lat, p.lon) ? p : null;
}

// ── Координаты текстом ──────────────────────────────────────────────────────

/** «56.526, 37.599», «56,5262 37,5999», «N56.52 E37.59», «56°31'34"N 37°35'59"E»,
 *  «56 31 34 С 37 35 59 В». null — если это не координаты. */
export function parseCoords(input: string): LatLon | null {
  const s = input.trim();
  if (!s || s.length > 120) return null;

  // Градусы-минуты-секунды (с буквами сторон света, лат. или кир.).
  const dms = [...s.matchAll(/(\d{1,3})\s*[°º]\s*(\d{1,2}(?:[.,]\d+)?)?\s*['′’]?\s*(\d{1,2}(?:[.,]\d+)?)?\s*(?:["″”]|'')?\s*([NSEWСЮВЗ])?/gi)];
  if (dms.length === 2) {
    const conv = (m: RegExpMatchArray) => {
      const v = Number(m[1]) + (m[2] ? num(m[2]) / 60 : 0) + (m[3] ? num(m[3]) / 3600 : 0);
      const h = (m[4] ?? '').toUpperCase();
      return { v: h === 'S' || h === 'W' || h === 'Ю' || h === 'З' ? -v : v, h };
    };
    const a = conv(dms[0]), b = conv(dms[1]);
    const aIsLon = /[EWВЗ]/.test(a.h);
    const p = aIsLon ? { lat: b.v, lon: a.v } : { lat: a.v, lon: b.v };
    if (validLatLon(p.lat, p.lon)) return p;
  }

  // Не координаты, если в строке есть слова (кроме сторон света) — это адрес с цифрами.
  const letters = s.replace(/\b[NSEWСЮВЗ]\b|[NSEWСЮВЗ](?=\s*-?\d)/gi, '').match(/\p{L}/u);
  if (letters) return null;

  // Десятичные: числа с ≥3 знаками после запятой/точки (так «ул. 40, кв 12» не пролезет).
  const nums = [...s.matchAll(/-?\d{1,3}[.,]\d{3,}/g)].map(m => num(m[0]));
  if (nums.length === 2) {
    let [lat, lon] = nums;
    const h = s.match(/[NSEWСЮВЗ]/gi)?.map(c => c.toUpperCase()) ?? [];
    if (/[EВ]/.test(h[0] ?? '') && /[NС]/.test(h[1] ?? '')) [lat, lon] = [lon, lat];
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
    if (validLatLon(lat, lon)) return { lat, lon };
  }
  return null;
}

// ── Ссылки на карты ────────────────────────────────────────────────────────

export type MapProvider = 'yandex' | 'google' | '2gis' | 'osm' | 'apple' | 'other';

export function looksLikeUrl(input: string): boolean {
  return /^(https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:ru|com|org|gl|app|me)\/)/i.test(input.trim());
}

function providerOf(host: string): MapProvider {
  if (/(^|\.)(yandex\.[a-z]+|ya\.ru)$/i.test(host)) return 'yandex';
  if (/(^|\.)(google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl)$/i.test(host)) return 'google';
  if (/(^|\.)2gis\.[a-z]+$/i.test(host)) return '2gis';
  if (/(^|\.)(openstreetmap\.org|osm\.org)$/i.test(host)) return 'osm';
  if (/(^|\.)apple\.com$/i.test(host)) return 'apple';
  return 'other';
}

/** Хосты, по коротким ссылкам которых сервер готов пройти редиректы (защита от
 *  SSRF: на произвольный адрес сервер не ходит никогда). */
export const SHORT_LINK_HOSTS = /^(?:(?:www\.)?yandex\.(?:ru|com|by|kz)|ya\.ru|maps\.app\.goo\.gl|goo\.gl|(?:www\.)?google\.[a-z.]+|go\.2gis\.com|(?:www\.)?2gis\.[a-z]+|(?:www\.)?osm\.org|(?:www\.)?openstreetmap\.org|maps\.apple\.com)$/i;

export function toUrl(input: string): URL | null {
  const s = input.trim();
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
}

/** Координаты из полной ссылки на карту. null — в ссылке их нет (короткая
 *  ссылка, ссылка на организацию) → сервер раскроет редирект и попробует снова. */
export function parseMapUrl(input: string): { point: LatLon; provider: MapProvider } | null {
  const u = toUrl(input);
  if (!u) return null;
  const provider = providerOf(u.hostname);
  const q = u.searchParams;
  const full = decodeURIComponent(u.href);
  let p: LatLon | null = null;

  switch (provider) {
    case 'yandex': {
      // pt — поставленная метка (точнее центра экрана ll); whatshere — «что здесь?».
      p = pair(q.get('pt'), 'lonlat') ?? pair(q.get('whatshere[point]'), 'lonlat') ?? pair(q.get('ll'), 'lonlat');
      if (!p) { const r = q.get('rtext'); if (r) p = pair(r.split('~').pop(), 'latlon'); }
      break;
    }
    case 'google': {
      const pin = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
      if (pin && validLatLon(Number(pin[1]), Number(pin[2]))) p = { lat: Number(pin[1]), lon: Number(pin[2]) };
      p ??= pair(q.get('q') ?? q.get('query') ?? q.get('destination') ?? q.get('ll'), 'latlon');
      if (!p) { const at = full.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); if (at) p = pair(`${at[1]},${at[2]}`, 'latlon'); }
      if (!p) { const s = full.match(/\/(?:search|place|dir)\/(-?\d+\.\d+),\+?\s*(-?\d+\.\d+)/); if (s) p = pair(`${s[1]},${s[2]}`, 'latlon'); }
      break;
    }
    case '2gis': {
      const m = q.get('m'); if (m) p = pair(m.split('/')[0], 'lonlat');
      if (!p) { const g = full.match(/\/geo\/(?:\d+\/)?(-?\d+\.\d+),(-?\d+\.\d+)/); if (g) p = pair(`${g[1]},${g[2]}`, 'lonlat'); }
      if (!p) { const g = full.match(/points\/[^?#]*?(-?\d+\.\d+),(-?\d+\.\d+)/); if (g) p = pair(`${g[1]},${g[2]}`, 'lonlat'); }
      break;
    }
    case 'osm': {
      const la = q.get('mlat'), lo = q.get('mlon');
      if (la && lo) p = pair(`${la},${lo}`, 'latlon');
      if (!p) { const h = u.hash.match(/map=\d+(?:\.\d+)?\/(-?\d+\.\d+)\/(-?\d+\.\d+)/); if (h) p = pair(`${h[1]},${h[2]}`, 'latlon'); }
      break;
    }
    case 'apple': {
      p = pair(q.get('ll') ?? q.get('coordinate') ?? q.get('q'), 'latlon');
      break;
    }
    default: {
      // Незнакомый сайт: только явная пара в query (lat/lon) — гадать не будем.
      const la = q.get('lat') ?? q.get('latitude'), lo = q.get('lon') ?? q.get('lng') ?? q.get('longitude');
      if (la && lo) p = pair(`${la},${lo}`, 'latlon');
    }
  }
  return p ? { point: p, provider } : null;
}

// ── Подготовка текста для геокодера ────────────────────────────────────────

const REGION_RE = /(област|обл\.?(?:\s|,|$)|край|республик|респ\.?(?:\s|,|$)|автономн|\bао\b|москва|санкт-петербург|севастополь)/i;

/** Варианты запроса от «как есть» к всё более упрощённым — каскад для DaData.
 *  Типовые проблемы адресов из заявок: индекс в начале, «Россия», «… федеральный
 *  округ», порядок «деревня → район → область» (как отдают карты), «сельское
 *  поселение» и прочие муниципальные слои, которые путают геокодер. */
export function queryVariants(input: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const v = s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
    if (v && v.length >= 3 && !out.includes(v)) out.push(v);
  };
  const raw = input.replace(/[«»"]/g, ' ').trim();
  add(raw);

  let parts = raw.split(',').map(p => p.trim().replace(/\.$/, '')).filter(Boolean);
  // Хвостовые «чистые цифры» — обрезанный индекс («…, 188» из выгрузки), не дом.
  while (parts.length > 1 && /^\d{2,6}$/.test(parts[parts.length - 1])) parts.pop();
  parts = parts
    .filter(p => !/^\d{6}$/.test(p) && !/^росси/i.test(p) && !/федеральный округ/i.test(p))
    .map(p => p.replace(/^\d{6}\s+/, ''));
  // Порядок «мелкое → крупное» (регион в хвосте) → разворачиваем к «крупное → мелкое».
  const regionIdx = parts.findIndex(p => REGION_RE.test(p));
  if (regionIdx > 0 && regionIdx >= parts.length / 2) {
    const house = /^\d+[а-яa-z]?(?:\s*(?:к|корп|стр)\.?\s*\d+)?$/i;
    // «32, Романовка, …» — номер дома впереди: держим его рядом с улицей/пунктом.
    const lead = house.test(parts[0]) ? parts.shift()! : null;
    parts = parts.reverse();
    if (lead) parts.push(lead);
  }
  add(parts.join(', '));

  const noMunicipal = parts.filter(p => !/(сельское поселение|городское поселение|муниципальн|городской округ|сельсовет)/i.test(p));
  add(noMunicipal.join(', '));

  // Крайняя мера — отрезаем самую мелкую часть, чтобы найти хотя бы населённый пункт.
  for (let n = noMunicipal.length - 1; n >= 2; n--) add(noMunicipal.slice(0, n).join(', '));
  return out.slice(0, 6);
}
