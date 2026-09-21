// Разбор адресного поля Битрикса и сравнение «объектов» между сделками.
// Отдельный модуль БЕЗ импорта БД и сети: используется и на сервере
// (lib/bitrix/dealAddress.ts), и в клиентских компонентах (карточка заказчика
// считает, на сколько разных объектов он возил). Импорт pg в клиентский бандл
// ломает сборку — тот же урок, что с features/customers/engine/contactTypes.ts.

export interface ParsedAddress { address: string | null; lat: number | null; lon: number | null }

/** Разбор «адрес||широта,долгота». Координаты необязательны. */
export function parseAddressCoords(raw: string | null | undefined): ParsedAddress {
  const v = (raw ?? '').trim();
  if (!v) return { address: null, lat: null, lon: null };
  const [head, tail] = v.split('||');
  const address = (head ?? '').trim() || null;
  if (!tail) return { address, lat: null, lon: null };
  const [latS, lonS] = tail.split(',');
  const lat = Number(latS);
  const lon = Number(lonS);
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return { address, lat: ok ? lat : null, lon: ok ? lon : null };
}

/**
 * Ключ «объекта» для сравнения адресов между сделками. Координаты — надёжнее
 * строки (её пишут руками и по-разному), округляем до ~100 м: одна и та же
 * стройплощадка в разных сделках даёт слегка разные точки. Без координат —
 * нормализованная строка.
 */
export function objectKey(a: ParsedAddress): string | null {
  if (a.lat !== null && a.lon !== null) return `${a.lat.toFixed(3)},${a.lon.toFixed(3)}`;
  const s = (a.address ?? '').toLowerCase().replace(/[«»"'.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}


/** Тот же критерий, что у STORED-колонки is_pickup (миграция 219): слово
 *  «Париж» целиком, без учёта регистра. «1-й Парижский проезд» и «улица
 *  Парижской Коммуны» — настоящие адреса доставки, их не трогаем. */
export function isPickupAddress(address: string | null | undefined): boolean {
  return !!address && /(^|[^\p{L}])\u043f\u0430\u0440\u0438\u0436([^\p{L}]|$)/iu.test(address);
}
