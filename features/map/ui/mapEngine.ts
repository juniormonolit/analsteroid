// ── Движок карты: MapLibre GL ────────────────────────────────────────────────
// Leaflet из проекта убран по прямому указанию владельца 21.09 («Leaflet НЕ
// ИСПОЛЬЗОВАТЬ НИКОГДА»). MapLibre GL заменяет сразу три библиотеки —
// leaflet + leaflet.markercluster + leaflet.heat:
//   * кластеризация встроена в GeoJSON-источник (cluster: true);
//   * тепловая карта — штатный тип слоя `heatmap`;
//   * точки, квадраты и круги — слои circle/fill/line, рисуются на WebGL, а не
//     в DOM: у нас 254 тыс. адресов, и Canvas-рендер Leaflet на них проседал.
// Тайлы и атрибуция те же (OSM), поэтому визуально карта не «переехала».
//
// ВАЖНО ПРО ПОРЯДОК КООРДИНАТ: MapLibre везде принимает [lng, lat], Leaflet
// принимал [lat, lng]. Все конвертации собраны в этом файле, чтобы страница с
// ними не путалась — самая частая ошибка при таком переезде.
//
// ПОЧЕМУ СЧЁТЧИКИ КЛАСТЕРОВ — DOM, А НЕ СЛОЙ symbol: слою symbol нужны глифы
// шрифта (style.glyphs), то есть внешний хост шрифтов. Кластеров на экране
// единицы-десятки, поэтому рисуем их обычными маркерами — и остаёмся без
// зависимости от чужого сервера. Точек при этом могут быть тысячи, и они идут
// через WebGL, где это и важно.

import type { Map as MlMap, GeoJSONSource, LngLatBoundsLike } from 'maplibre-gl';

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * Путь к воркеру MapLibre, который отдаём мы сами (scripts/copy-maplibre-worker.mjs
 * кладёт его в public/maplibre на каждой сборке).
 *
 * БЕЗ ЭТОГО КАРТА МОЛЧА ПУСТАЯ (инцидент 21.09). MapLibre вычисляет адрес
 * воркера как `new URL('./maplibre-gl-worker.mjs', import.meta.url)`, а внутри
 * бандла Next `import.meta.url` — это адрес чанка (/_next/static/chunks/...),
 * где такого файла нет. Воркер не стартует, и дальше всё выглядит исправным,
 * кроме главного: растровые тайлы рисуются (им воркер не нужен), слои
 * создаются, фичи в источник кладутся — а на экране ноль, потому что разбор и
 * нарезка GeoJSON идут именно в воркере. Диагностический признак — вечное
 * `map.isStyleLoaded() === false` при отсутствии каких-либо ошибок.
 */
export const WORKER_URL = '/maplibre/maplibre-gl-worker.mjs';

/** Выставить адрес воркера ДО создания первой карты. Идемпотентно. */
export function ensureWorkerUrl(ml: { config: { WORKER_URL: string } }): void {
  if (ml.config.WORKER_URL !== WORKER_URL) ml.config.WORKER_URL = WORKER_URL;
}

/** Пустой стиль с одним растровым слоем OSM — без внешнего style.json. */
export function osmStyle(): object {
  return {
    version: 8,
    sources: { osm: { type: 'raster', tiles: [OSM_TILES], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap' } },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  };
}

export type LonLat = [number, number];
/** Leaflet-порядок [lat, lon] → MapLibre [lon, lat]. */
export const toLngLat = (lat: number, lon: number): LonLat => [lon, lat];

/** Габариты по набору точек (lat/lon) в формате MapLibre. */
export function boundsOf(pts: { lat: number; lon: number }[]): LngLatBoundsLike | null {
  if (pts.length === 0) return null;
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of pts) {
    if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
  }
  // Вырожденный случай (одна точка): даём небольшую рамку, иначе fitBounds
  // уводит зум в максимум и карта «прыгает».
  if (w === e && s === n) return [[w - 0.02, s - 0.02], [e + 0.02, n + 0.02]];
  return [[w, s], [e, n]];
}

/** Круг заданного радиуса (км) как полигон — у MapLibre нет «круга в метрах». */
export function circlePolygon(lat: number, lon: number, radiusKm: number, steps = 64): GeoJSON.Feature<GeoJSON.Polygon> {
  const ring: LonLat[] = [];
  const latR = radiusKm / 111.32;                                   // градус широты ≈ 111,32 км
  const lonR = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180)); // на широте круг «сплющен»
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + lonR * Math.cos(a), lat + latR * Math.sin(a)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** Прямоугольник по границам в формате [[lat,lon],[lat,lon]] (так их отдаёт API). */
export function rectPolygon(b: [[number, number], [number, number]], props: Record<string, unknown>): GeoJSON.Feature<GeoJSON.Polygon> {
  const [[s, w], [n, e]] = b;
  return {
    type: 'Feature', properties: props,
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
}

/** Заменить данные источника, создав его при первом вызове. */
export function setGeoJson(map: MlMap, id: string, data: GeoJSON.FeatureCollection, opts?: object): void {
  const src = map.getSource(id) as GeoJSONSource | undefined;
  if (src) { src.setData(data); return; }
  map.addSource(id, { type: 'geojson', data, ...(opts ?? {}) } as never);
}

/** Снять слои и источник, если они есть (порядок важен: сначала слои). */
export function dropLayers(map: MlMap, layerIds: string[], sourceId?: string): void {
  for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
  if (sourceId && map.getSource(sourceId)) map.removeSource(sourceId);
}

export const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
