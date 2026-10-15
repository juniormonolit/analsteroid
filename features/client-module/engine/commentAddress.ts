// Адрес из комментария заявки 1С (решение владельца 15.10). В поле адреса заявки
// часто только город («Одинцово…»), а точный адрес и координаты менеджер пишет в
// комментарий: «КП Малое Сареево, 28, … 55.711585, 37.199019». Такой адрес берём
// как есть, без перепроверки, с пометкой источника.
//
// Комментарий читаем ТОЛЬКО ради адреса: наружу (в ответ API, в UI) уходит лишь
// найденный фрагмент-адрес и точка. Телефоны, ФИО, паспорта и прочее из
// комментария вырезаются до разбора и никуда не попадают.

import { parseMapUrl, validLatLon } from '@/lib/geo/parse';

export interface CommentAddress { address: string | null; lat: number | null; lon: number | null }

const inRussia = (lat: number, lon: number) => lat >= 41 && lat <= 82 && lon >= 19 && lon <= 180;

// Границы слов вручную: \b в JS не работает с кириллицей.
const B = '(?:^|[\\s,.(«"])';
const E = '(?=$|[\\s,.)»"\\d])';
const MARKERS = new RegExp(B + '(ул|улица|д|дом|кп|снт|днт|днп|тсн|пос|п|пгт|посёлок|поселок|деревня|дер|село|с|г|город|ш|шоссе|км|уч|участок|мкр|микрорайон|проезд|пр-д|пер|переулок|обл|область|р-н|район|го|округ|корп|к|стр|строение|тер|территория|вл|владение|кв-л|квартал|наб|проспект|пр-т|бульвар|тупик|линия)' + E, 'gi');
// Фрагменты не про адрес (оплата, контакты, документы) — отбрасываем целиком.
const NOT_ADDRESS = /паспорт|тел[.:]|телефон|звонить|позвонить|оплат|сч[её]т|руб|скидк|долг|инн|доверенн|подпис|водител|выдан|серия|код подр/i;
const PHONE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;
const LONG_DIGITS = /\d[\d\s-]{6,}\d/g;            // паспорта, счета, индексы — без них адрес не страдает
const COORDS = /(-?\d{2}[.,]\d{4,})\s*[,;\s]\s*(-?\d{2,3}[.,]\d{4,})/;
// Подпись перед двоеточием: «Адрес:», «Доставка:», «Доставка леруа:», «Адрес объекта —».
const LABEL = /^\s*(?:[а-яё]+\s+){0,2}(?:доставк[аиу]|адрес|куда|объект|выгрузк[аи]|разгрузк[аи])(?:\s+[а-яё]+){0,2}\s*[:\-–—]\s*/i;
// Фрагмент про склад/самовывоз — это не объект клиента («Склад: …, Люберцы»).
const WAREHOUSE = /^\s*(?:склад|со склада|с нашего склада|забрать|забира|самовывоз|отгрузка со?|погрузка|загрузка)/i;

function coordsIn(s: string): { lat: number; lon: number; index: number } | null {
  // Ссылка на карту в комментарии — точнее всего.
  for (const m of s.matchAll(/https?:\/\/\S+/g)) {
    const p = parseMapUrl(m[0]);
    if (p && inRussia(p.point.lat, p.point.lon)) return { ...p.point, index: m.index ?? 0 };
  }
  const m = s.match(COORDS);
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.')), lon = Number(m[2].replace(',', '.'));
  if (!validLatLon(lat, lon) || !inRussia(lat, lon)) return null;
  return { lat, lon, index: m.index ?? 0 };
}

// Части через запятую про доставку, а не про место («разгрузка манипулятором»).
const NOISE = /разгруз|выгруз|манипулятор|кран|заезд|въезд|машин|привез|достав|обед|утр|вечер|звон|ворот|шлагбаум|пропуск|охран|ждать|ждут/i;

function clean(s: string): string {
  s = s.replace(LABEL, '');
  s = s.split(',').filter(p => !NOISE.test(p)).join(',');
  return s.replace(/https?:\/\/\S+/g, ' ')
    .replace(LABEL, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, '')
    .slice(0, 160)
    .trim();
}

const markerCount = (s: string) => (s.match(MARKERS) ?? []).length;
// «Сильный» маркер — не одна буква (с/д/к/п/г/ш легко встречаются в обычной речи).
const strongCount = (s: string) => (s.match(MARKERS) ?? []).filter(m => m.replace(/[^а-яё-]/gi, '').length > 1).length;
const TIME = /(?:^|\s)с\s*\d{1,2}(?:[:.]\d{2})?\s*до\s*\d{1,2}(?:[:.]\d{2})?|\d{1,2}:\d{2}/gi;

/** Адрес и/или точка из комментария заявки. null — адреса в комментарии нет. */
export function addressFromComment(comment: string | null | undefined): CommentAddress | null {
  if (!comment) return null;
  const text = comment.replace(/\r/g, '').replace(PHONE, ' ');
  const segments = text.split(/\n|;|(?<=[а-яёa-z]{4}[.!?])\s+(?=[А-ЯЁA-Z])/i).map(s => s.trim()).filter(Boolean);

  let point: { lat: number; lon: number } | null = null;
  let address: string | null = null;
  let best = 0;
  for (const seg of segments) {
    if (WAREHOUSE.test(seg)) continue;                // склад — ни адрес, ни точка
    const c = coordsIn(seg);
    // Текст до координат в том же фрагменте — это и есть адрес точки.
    const before = c ? seg.slice(0, c.index) : seg;
    if (c && !point) point = { lat: c.lat, lon: c.lon };
    if (NOT_ADDRESS.test(before)) continue;
    const cand = clean(before.replace(LONG_DIGITS, ' ').replace(TIME, ' '));
    if (cand.length < 6 || !/[а-яё]{3,}/i.test(cand)) continue;
    const markers = markerCount(cand), strong = strongCount(cand), digit = /\d/.test(cand);
    // Адрес: сильный маркер («КП», «ул», «СНТ») плюс второй маркер или номер дома;
    // либо текст прямо перед точкой из того же фрагмента.
    const isAddr = (strong >= 1 && (markers >= 2 || digit)) || (c && cand.includes(','));
    const score = markers * 2 + (digit ? 1 : 0) + (c ? 3 : 0);
    if (isAddr && score > best) { best = score; address = cand; }
  }
  if (!address && !point) return null;
  return { address, lat: point?.lat ?? null, lon: point?.lon ?? null };
}
