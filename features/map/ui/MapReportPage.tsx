'use client';
// Спец-отчёт «Карта объектов» (задача владельца 21.09; вторая итерация — по
// правке «Все что напрашивается — делаем. Еще масштабирование под размер
// экрана. И разбивку на товарные категории. И чтобы можно было кликать на
// кластер в большом размере и видеть все сделки там списком»).
//
// Точка на карте = ОБЪЕКТ (адрес доставки), а не сделка: на один адрес часто
// возят несколько раз, и «3 сделки на 1,2 млн» читается лучше трёх меток друг
// на друге. Цвет точки — ведущая товарная группа объекта (по деньгам).
//
// Что умеет:
//   • точки с кластеризацией; клик по КЛАСТЕРУ — список всех его объектов и
//     сделок (кластер не улетает в зум сам: zoomToBoundsOnClick=false, зум —
//     отдельной кнопкой в панели);
//   • тепловая карта (штатный слой heatmap) — включается поверх или вместо точек;
//   • круги радиусов вокруг филиалов (25/50/100 км) — «домашняя зона»;
//   • «соседи» выбранного объекта по ВСЕЙ истории (/api/map/neighbors) —
//     749 кустов с 3+ заказчиками дают больше половины выручки, это рабочий
//     инструмент, а не украшение;
//   • раскладка по высоте экрана (h-dvh, карта тянется) + режим «на весь
//     экран»; на телефоне панель уезжает под карту.
//
// Карта — MapLibre GL + OSM-тайлы (Leaflet убран по указанию владельца 21.09,
// подробности и причины переезда — в features/map/ui/mapEngine.ts). Библиотека
// грузится динамически в эффекте: она лезет к window и на сервере не живёт.
// Координаты в MapLibre — [lng, lat]; конвертация собрана в mapEngine.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { MapPin, Loader2, X, Maximize2, Minimize2, SlidersHorizontal, ZoomIn, ChevronDown, Check } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { GS_BASE_ROW, mixHex } from '@/lib/colors/google-sheets-palette';
import 'maplibre-gl/dist/maplibre-gl.css';
import { osmStyle, boundsOf, circlePolygon, rectPolygon, setGeoJson, dropLayers, EMPTY_FC } from './mapEngine';

const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });

interface ObjItem { dealId: number; amount: number; at: string | null; manager: string | null; group: string | null; name: string | null }
interface GroupSlice { group: string; deals: number; sum: number }
interface MapObject {
  key: string; lat: number; lon: number; address: string; hot: boolean;
  deals: number; sum: number; clients: number;
  topGroup: string | null; groups: GroupSlice[]; items: ObjItem[];
}
interface Facets {
  managers: { id: string; name: string; department: string | null; deals: number; sum: number }[];
  groups: GroupSlice[];
  departments: { department: string; deals: number; sum: number }[];
}
interface MapData {
  objects: MapObject[];
  summary: { deals: number; sum: number; objects: number; clients: number; withoutCoords: number; hiddenServiceDeals: number; pickupDeals: number; shown: number; truncated: boolean };
  facets: Facets;
}
interface ConvCell {
  key: string; bounds: [[number, number], [number, number]]; lat: number; lon: number;
  deals: number; sold: number; delivered: number; convSale: number; convShip: number;
  sum: number; soldSum: number;
  topAddresses: { address: string; deals: number; sold: number }[];
  items: { dealId: number; amount: number; at: string | null; manager: string | null; group: string | null; address: string | null; sold: boolean; delivered: boolean }[];
}
interface ConvData {
  cells: ConvCell[]; cellKm: number; minDeals: number;
  summary: { deals: number; sold: number; delivered: number; withoutCoords: number; pickupDeals: number; convSale: number; convShip: number; cells: number; hiddenCells: number; truncated: boolean };
  facets: Facets;
}
interface Neighbours {
  radiusKm: number; objects: number; deals: number; sum: number; clients: number; lastAt: string | null;
  items: { key: string; address: string; lat: number; lon: number; distanceKm: number; deals: number; sum: number; clients: number; lastAt: string | null }[];
}

const STATES = [
  { key: 'delivered', label: 'Отгрузки', hint: 'Сделки, отгруженные в периоде (дата отгрузки)' },
  { key: 'sold', label: 'Продажи', hint: 'Сделки, проданные в периоде (дата продажи)' },
  { key: 'active', label: 'В работе', hint: 'Не проданы, не отгружены, не отказ — созданные в периоде' },
  { key: 'lost', label: 'Отказы', hint: 'Сделки, ушедшие в отказ в периоде' },
  { key: 'all', label: 'Все', hint: 'Любые сделки по выбранной базе даты' },
];
const FUNNELS = [
  { key: 'all', label: 'Все воронки' }, { key: 'primary', label: 'Первичные' }, { key: 'repeat', label: 'Повторные' },
];
const CLIENTS = [
  { key: 'all', label: 'ЮЛ и ФЛ' }, { key: 'company', label: 'Юрлица' }, { key: 'contact', label: 'Физлица' },
];
/** Филиалы для кругов «домашней зоны» — те же города, что в UF_REGION Битрикса. */
const BRANCHES: { name: string; lat: number; lon: number }[] = [
  { name: 'Санкт-Петербург', lat: 59.9386, lon: 30.3141 },
  { name: 'Москва', lat: 55.7558, lon: 37.6173 },
  { name: 'Краснодар', lat: 45.0355, lon: 38.9753 },
  { name: 'Воронеж', lat: 51.6606, lon: 39.2006 },
  { name: 'Нижний Новгород', lat: 56.3269, lon: 44.0059 },
  { name: 'Ростов-на-Дону', lat: 47.2225, lon: 39.7187 },
  { name: 'Волгоград', lat: 48.7071, lon: 44.5170 },
];
const RADII_KM = [25, 50, 100];
const OTHER_COLOR = '#9e9e9e';

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function monthAgo(n: number): string { const d = new Date(); d.setMonth(d.getMonth() - n); return ymd(d); }
function fmtMoney(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1_000).toLocaleString('ru-RU')} тыс ₽`;
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

type Selection =
  | { kind: 'object'; object: MapObject }
  | { kind: 'cluster'; objects: MapObject[] }
  | { kind: 'cell'; cell: ConvCell }
  | null;

/** Режим карты: что именно показываем точками/квадратами. */
type MapMode = 'objects' | 'conv_sale' | 'conv_ship';
const MODES: { key: MapMode; label: string; hint: string }[] = [
  { key: 'objects', label: 'Объекты', hint: 'Точки по адресам: сколько отгрузок и на сколько денег' },
  { key: 'conv_sale', label: 'CR в продажу', hint: 'Из сделок, СОЗДАННЫХ в периоде, сколько дошло до продажи — по квадратам карты' },
  { key: 'conv_ship', label: 'CR в отгрузку', hint: 'Из сделок, СОЗДАННЫХ в периоде, сколько дошло до отгрузки — по квадратам карты' },
];
const CELL_KM = [5, 10, 25, 50];

/** Цвет квадрата: сравнение с СРЕДНЕЙ конверсией текущей выборки, а не с
 *  абстрактной шкалой. Вопрос владельца — «где хуже, чем обычно», а «обычно»
 *  у утеплителя и у щебня разное. */
function convColor(conv: number, avg: number): string {
  if (avg <= 0) return '#9e9e9e';
  const r = conv / avg;
  if (conv === 0) return '#b91c1c';
  if (r < 0.6) return '#dc2626';
  if (r < 0.85) return '#f97316';
  if (r < 1.15) return '#eab308';
  if (r < 1.4) return '#84cc16';
  return '#16a34a';
}

export function MapReportPage() {
  const [from, setFrom] = useState(monthAgo(1));
  const [to, setTo] = useState(ymd(new Date()));
  const [state, setState] = useState('delivered');
  const [funnel, setFunnel] = useState('all');
  const [client, setClient] = useState('all');
  const [groups, setGroups] = useState<string[]>([]);
  const [managers, setManagers] = useState<string[]>([]);
  const [depts, setDepts] = useState<string[]>([]);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [buildersOnly, setBuildersOnly] = useState(false);
  const [withHot, setWithHot] = useState(false);
  const [mode, setMode] = useState<MapMode>('objects');
  const [cellKm, setCellKm] = useState(25);
  const [minDeals, setMinDeals] = useState(5);
  const [layer, setLayer] = useState<'points' | 'heat' | 'both'>('points');
  const [branchRadius, setBranchRadius] = useState(0);   // 0 = круги выключены
  const [fullscreen, setFullscreen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);  // на телефоне фильтры свёрнуты
  const [selected, setSelected] = useState<Selection>(null);
  const [openDealId, setOpenDealId] = useState<number | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`, state, funnel, client });
    if (groups.length) p.set('groups', groups.join(','));
    if (managers.length) p.set('managers', managers.join(','));
    if (depts.length) p.set('depts', depts.join(','));
    if (min) p.set('min', min);
    if (max) p.set('max', max);
    if (buildersOnly) p.set('builders', '1');
    if (withHot) p.set('hot', '1');
    return p.toString();
  }, [from, to, state, funnel, client, groups, managers, depts, min, max, buildersOnly, withHot]);

  const isConv = mode !== 'objects';
  const { data, isFetching, isError } = useQuery<MapData>({
    queryKey: ['map-points', qs],
    enabled: !isConv,
    queryFn: () => fetch(`/api/map/points?${qs}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  // Конверсия — свой роут: там другая единица (квадрат сетки, а не объект) и
  // другая когорта (сделки, СОЗДАННЫЕ в периоде), поэтому смешивать нельзя.
  const convQs = useMemo(() => `${qs}&cell=${cellKm}&minDeals=${minDeals}`, [qs, cellKm, minDeals]);
  const { data: conv, isFetching: convFetching, isError: convError } = useQuery<ConvData>({
    queryKey: ['map-conversion', convQs],
    enabled: isConv,
    queryFn: () => fetch(`/api/map/conversion?${convQs}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  // Фасеты (списки фильтров) берём из активного источника — они одинаковой формы.
  const facets: Facets = (isConv ? conv?.facets : data?.facets) ?? { managers: [], groups: [], departments: [] };

  // Палитра товарных групп: восемь ведущих по деньгам получают свой цвет,
  // остальное — серое «прочее». Легенда снизу карты кликается как фильтр.
  const groupColor = useMemo(() => {
    const top = facets.groups.slice(0, 8).map(g => g.group);
    const colors = [GS_BASE_ROW[6], GS_BASE_ROW[4], GS_BASE_ROW[2], GS_BASE_ROW[8], GS_BASE_ROW[1], GS_BASE_ROW[5], GS_BASE_ROW[9], GS_BASE_ROW[3]]
      .map(c => mixHex(c, '#000000', 0.12));
    const m = new Map<string, string>();
    top.forEach((g, i) => m.set(g, colors[i % colors.length]!));
    return m;
  }, [facets.groups]);
  const colorOf = useCallback((o: MapObject) => (o.hot ? '#f59e0b' : groupColor.get(o.topGroup ?? '') ?? OTHER_COLOR), [groupColor]);

  // ── Карта ────────────────────────────────────────────────────────────────
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  /** DOM-маркеры кластеров: их единицы, счётчик нужен текстом (см. mapEngine). */
  const clusterMarkers = useRef<import('maplibre-gl').Marker[]>([]);
  const popupRef = useRef<import('maplibre-gl').Popup | null>(null);
  const [ml, setMl] = useState<typeof import('maplibre-gl') | null>(null);
  const [ready, setReady] = useState(false);
  const [mapErr, setMapErr] = useState<string | null>(null);
  // Диагностика по ?mapdebug=1 — чтобы не гадать вслепую, когда карта пустая.
  const [dbg, setDbg] = useState<string>('—');
  const debugOn = typeof window !== 'undefined' && window.location.search.includes('mapdebug=1');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import('maplibre-gl');
      const M = (mod as unknown as { default?: typeof mod }).default ?? mod;
      if (cancelled || !mapEl.current || mapRef.current) return;
      const map = new M.Map({
        container: mapEl.current,
        style: osmStyle() as never,
        center: [30.31, 59.94],   // [lng, lat]
        zoom: 5,
        attributionControl: { compact: true },
      });
      map.addControl(new M.NavigationControl({ showCompass: false }), 'top-right');
      mapRef.current = map;
      popupRef.current = new M.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
      // Готовность: 'load' мог уже произойти к моменту подписки (стиль тут
      // инлайновый, без сети), поэтому проверяем и текущее состояние, и
      // дублируем на 'idle'. Без этого все слои молча не создавались бы —
      // ровно этот класс отказа искали 21.09.
      const markReady = () => { if (!cancelled) setReady(true); };
      if (map.loaded()) markReady(); else { map.once('load', markReady); map.once('idle', markReady); }
      map.on('error', e => {
        const msg = (e as unknown as { error?: { message?: string } }).error?.message ?? 'unknown';
        setMapErr(prev => (prev ? prev : msg));
        console.warn('[map] error:', msg);
      });
      setMl(M);
    })();
    return () => {
      cancelled = true;
      clusterMarkers.current.forEach(m => m.remove());
      clusterMarkers.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Масштабирование под размер экрана (правка владельца): при любом изменении
  // размеров контейнера — полноэкранный режим, поворот телефона, свёрнутые
  // фильтры — карта обязана пересчитать вьюпорт, иначе половина остаётся серой.
  useEffect(() => {
    const el = mapEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { mapRef.current?.resize(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.resize(), 60);
    return () => clearTimeout(t);
  }, [fullscreen, filtersOpen, selected]);

  // ── Точки + кластеры ──────────────────────────────────────────────────────
  // Один GeoJSON-источник с cluster:true. Одиночные точки — слой circle (WebGL,
  // тысячи штук без просадки), кластеры — DOM-маркеры: счётчик нужен текстом, а
  // текстовому слою MapLibre требуются глифы с внешнего хоста (см. mapEngine).
  const objByKey = useMemo(() => new Map((data?.objects ?? []).map(o => [o.key, o] as const)), [data]);
  // Обработчики слоёв навешиваются ОДИН раз при создании слоя и замыкают первое
  // значение данных. Поэтому читаем актуальные данные через ref, иначе клик по
  // точке после смены фильтров открывал бы карточку из прошлой выборки.
  const objByKeyRef = useRef(objByKey);
  useEffect(() => { objByKeyRef.current = objByKey; }, [objByKey]);
  const convRef = useRef<ConvData | null>(null);
  useEffect(() => { convRef.current = conv ?? null; }, [conv]);

  // Кластеры рисует НАСТОЯЩИЙ слой circle, а не только DOM-маркеры. Это не
  // косметика: на стартовом зуме кластеризуется ВСЁ, слой одиночных точек
  // (filter: нет point_count) честно рисует ноль, и если кружки держатся лишь
  // на querySourceFeatures + DOM-маркерах, то любая осечка этой связки =
  // пустая карта. Ровно это и случилось после переезда с Leaflet (21.09):
  // тайлы грузились, а данных не было видно вообще. Теперь кружки — WebGL, а
  // DOM-маркеры остались только подписями поверх и ни на что не влияют.
  const syncClusterLabels = useCallback(() => {
    const map = mapRef.current, M = ml;
    if (!map || !M) return;
    clusterMarkers.current.forEach(mk => mk.remove());
    clusterMarkers.current = [];
    if (!map.getLayer('clusters')) return;
    for (const f of map.queryRenderedFeatures({ layers: ['clusters'] })) {
      const n = Number(f.properties?.point_count ?? 0);
      if (!n) continue;
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      const el = document.createElement('div');
      // Подпись не ловит клики — кликается сам слой кластеров под ней.
      el.style.cssText = `pointer-events:none;color:#fff;font-weight:700;font-size:${n < 100 ? 13 : 11}px;text-shadow:0 1px 2px rgba(0,0,0,.35)`;
      el.textContent = String(n);
      clusterMarkers.current.push(new M.Marker({ element: el }).setLngLat([lng, lat]).addTo(map));
    }
  }, [ml]);
  const syncRef = useRef(syncClusterLabels);
  useEffect(() => { syncRef.current = syncClusterLabels; }, [syncClusterLabels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const hide = layer === 'heat' || isConv || !data;
    const maxSum = Math.max(1, ...(data?.objects ?? []).map(o => o.sum));
    const fc: GeoJSON.FeatureCollection = hide ? EMPTY_FC : {
      type: 'FeatureCollection',
      features: data!.objects.map(o => ({
        type: 'Feature' as const,
        properties: { key: o.key, sum: o.sum, r: 5 + Math.round(9 * Math.sqrt(o.sum / maxSum)), color: colorOf(o) },
        geometry: { type: 'Point' as const, coordinates: [o.lon, o.lat] },
      })),
    };
    setGeoJson(map, 'objects', fc, { cluster: true, clusterRadius: 50, clusterMaxZoom: 14 });

    if (!map.getLayer('clusters')) {
      map.addLayer({
        id: 'clusters', type: 'circle', source: 'objects', filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 17, 10, 21, 100, 26],
          'circle-color': 'rgba(37,99,235,.85)',
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(255,255,255,.9)',
        },
      });
      // Клик по кластеру не улетает в зум (правка владельца: «кликать на кластер
      // и видеть все сделки там списком») — зум отдельной кнопкой в панели.
      map.on('click', 'clusters', async e => {
        const id = e.features?.[0]?.properties?.cluster_id;
        if (id === undefined) return;
        const src = map.getSource('objects') as import('maplibre-gl').GeoJSONSource;
        const leaves = await src.getClusterLeaves(Number(id), 10_000, 0);
        const objs = leaves
          .map(l => objByKeyRef.current.get(String((l.properties as { key?: string } | null)?.key ?? '')))
          .filter((o): o is MapObject => !!o)
          .sort((x, y) => y.sum - x.sum);
        setSelected({ kind: 'cluster', objects: objs });
      });
      map.on('mouseenter', 'clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'clusters', () => { map.getCanvas().style.cursor = ''; });
    }
    if (!map.getLayer('obj-points')) {
      map.addLayer({
        id: 'obj-points', type: 'circle', source: 'objects', filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['get', 'r'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.8,
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(0,0,0,.35)',
        },
      });
      map.on('click', 'obj-points', e => {
        const k = String(e.features?.[0]?.properties?.key ?? '');
        const o = objByKeyRef.current.get(k);
        if (o) setSelected({ kind: 'object', object: o });
      });
      map.on('mouseenter', 'obj-points', e => {
        map.getCanvas().style.cursor = 'pointer';
        const k = String(e.features?.[0]?.properties?.key ?? '');
        const o = objByKeyRef.current.get(k);
        if (!o || !popupRef.current) return;
        popupRef.current
          .setLngLat([o.lon, o.lat])
          .setHTML(`${o.address}<br><b>${fmtMoney(o.sum)}</b> · сделок ${o.deals}${o.topGroup ? `<br>${o.topGroup}` : ''}${o.hot ? '<br><i>служебная точка: дефолтный адрес, не объект</i>' : ''}`)
          .addTo(map);
      });
      map.on('mouseleave', 'obj-points', () => { map.getCanvas().style.cursor = ''; popupRef.current?.remove(); });
    }
    // В режимах без точек слои прячем, а источник оставляем — чтобы не
    // пересобирать тайлы кластеров на каждом переключении.
    const vis = hide ? 'none' : 'visible';
    map.setLayoutProperty('clusters', 'visibility', vis);
    map.setLayoutProperty('obj-points', 'visibility', vis);
    if (hide) { clusterMarkers.current.forEach(mk => mk.remove()); clusterMarkers.current = []; }
    else syncRef.current();
  }, [ready, data, layer, colorOf, isConv]);

  // Сбор диагностики (только при ?mapdebug=1).
  useEffect(() => {
    if (!debugOn) return;
    const t = setInterval(() => {
      const map = mapRef.current;
      if (!map) { setDbg('карта не создана'); return; }
      const src = map.getSource('objects') as { serialize?: () => { data?: { features?: unknown[] } } } | undefined;
      const inSrc = (() => { try { return src?.serialize?.().data?.features?.length ?? '—'; } catch { return '?'; } })();
      const q = (id: string) => { try { return map.getLayer(id) ? map.queryRenderedFeatures({ layers: [id] }).length : 'нет слоя'; } catch { return 'ошибка'; } };
      setDbg([
        `ready=${ready}`, `styleLoaded=${map.isStyleLoaded()}`, `loaded=${map.loaded()}`,
        `zoom=${map.getZoom().toFixed(1)}`,
        `objects.features=${inSrc}`,
        `data.objects=${data?.objects.length ?? '—'}`,
        `layers=[${map.getStyle().layers.map(l => l.id).join(',')}]`,
        `rendered: clusters=${q('clusters')} points=${q('obj-points')}`,
        `err=${mapErr ?? 'нет'}`,
      ].join(' · '));
    }, 1000);
    return () => clearInterval(t);
  }, [debugOn, ready, data, mapErr]);

  // Подписи кластеров пересчитываем ПОСЛЕ отрисовки: queryRenderedFeatures
  // читает то, что реально нарисовано, и до 'idle' отдаёт неполный набор.
  // Слушатели вешаются ОДИН раз и зовут актуальную функцию через ref — иначе
  // каждый ререндер снимал бы и ставил их заново.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const run = () => syncRef.current();
    map.on('idle', run);
    map.on('move', run);
    return () => { map.off('idle', run); map.off('move', run); };
  }, [ready]);

  // Тепловая карта: вес точки — деньги, поэтому «горячо» там, где выручка, а
  // не там, где просто много мелких отгрузок. Штатный слой heatmap.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const show = layer !== 'points' && !isConv && !!data;
    const maxSum = Math.max(1, ...(data?.objects ?? []).map(o => o.sum));
    const fc: GeoJSON.FeatureCollection = !show ? EMPTY_FC : {
      type: 'FeatureCollection',
      features: data!.objects.map(o => ({
        type: 'Feature' as const,
        properties: { w: Math.max(0.15, o.sum / maxSum) },
        geometry: { type: 'Point' as const, coordinates: [o.lon, o.lat] },
      })),
    };
    setGeoJson(map, 'heat', fc);
    if (!map.getLayer('heat-layer')) {
      map.addLayer({
        id: 'heat-layer', type: 'heatmap', source: 'heat',
        paint: {
          'heatmap-weight': ['get', 'w'],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 18, 12, 34],
          'heatmap-opacity': 0.75,
        },
      }, map.getLayer('obj-points') ? 'obj-points' : undefined);
    }
  }, [ready, data, layer, isConv]);

  // Квадраты конверсии (правка владельца 21.09: «где территориально у меня
  // самая низкая конверсия?»). Считаем не по объекту — по одному адресу с
  // двумя сделками конверсия всегда 0% или 100%, это шум, — а по квадратам
  // сетки с порогом по числу сделок. Цвет — относительно СРЕДНЕЙ конверсии
  // текущей выборки: «хуже, чем обычно у этого товара», а не по абсолютной
  // шкале, где утеплитель и щебень несравнимы.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const show = isConv && !!conv;
    const avg = !conv ? 0 : mode === 'conv_sale' ? conv.summary.convSale : conv.summary.convShip;
    const maxDeals = Math.max(1, ...(conv?.cells ?? []).map(c => c.deals));
    const fc: GeoJSON.FeatureCollection = !show ? EMPTY_FC : {
      type: 'FeatureCollection',
      features: conv!.cells.map(c => {
        const value = mode === 'conv_sale' ? c.convSale : c.convShip;
        return rectPolygon(c.bounds, {
          key: c.key, color: convColor(value, avg),
          // Прозрачность по объёму: квадрат на 5 сделках не должен кричать так
          // же, как квадрат на 200 — иначе «проблема» найдётся там, где просто
          // мало данных.
          opacity: 0.25 + 0.45 * Math.sqrt(c.deals / maxDeals),
          tip: `${mode === 'conv_sale' ? 'CR в продажу' : 'CR в отгрузку'}: <b>${value}%</b>`
             + `<br>${mode === 'conv_sale' ? c.sold : c.delivered} из ${c.deals} сделок`
             + `<br>средняя по выборке ${avg}%`,
        });
      }),
    };
    setGeoJson(map, 'cells', fc);
    if (!map.getLayer('cells-fill')) {
      map.addLayer({ id: 'cells-fill', type: 'fill', source: 'cells',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] } });
      map.addLayer({ id: 'cells-line', type: 'line', source: 'cells',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1 } });
      map.on('click', 'cells-fill', e => {
        const k = String(e.features?.[0]?.properties?.key ?? '');
        const cell = convRef.current?.cells.find(c => c.key === k);
        if (cell) setSelected({ kind: 'cell', cell });
      });
      map.on('mouseenter', 'cells-fill', e => {
        map.getCanvas().style.cursor = 'pointer';
        const tip = String(e.features?.[0]?.properties?.tip ?? '');
        if (tip && popupRef.current) popupRef.current.setLngLat(e.lngLat).setHTML(tip).addTo(map);
      });
      map.on('mouseleave', 'cells-fill', () => { map.getCanvas().style.cursor = ''; popupRef.current?.remove(); });
    }
    if (show && conv!.cells.length > 0) {
      const b = boundsOf(conv!.cells.flatMap(c => [{ lat: c.bounds[0][0], lon: c.bounds[0][1] }, { lat: c.bounds[1][0], lon: c.bounds[1][1] }]));
      if (b) map.fitBounds(b, { padding: 40, maxZoom: 11 });
    }
  }, [ready, conv, isConv, mode]);

  // Круги «домашней зоны» вокруг филиалов. У MapLibre нет круга в метрах —
  // считаем полигон (mapEngine.circlePolygon), иначе радиус «плыл» бы с широтой.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc: GeoJSON.FeatureCollection = !branchRadius ? EMPTY_FC : {
      type: 'FeatureCollection',
      features: BRANCHES.map(b => circlePolygon(b.lat, b.lon, branchRadius)),
    };
    setGeoJson(map, 'zones', fc);
    if (!map.getLayer('zones-line')) {
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
        paint: { 'line-color': '#1d4ed8', 'line-width': 1, 'line-dasharray': [4, 4] } });
    }
    const centers: GeoJSON.FeatureCollection = !branchRadius ? EMPTY_FC : {
      type: 'FeatureCollection',
      features: BRANCHES.map(b => ({ type: 'Feature' as const, properties: { name: `${b.name} · радиус ${branchRadius} км` },
        geometry: { type: 'Point' as const, coordinates: [b.lon, b.lat] } })),
    };
    setGeoJson(map, 'branches', centers);
    if (!map.getLayer('branches-dot')) {
      map.addLayer({ id: 'branches-dot', type: 'circle', source: 'branches',
        paint: { 'circle-radius': 4, 'circle-color': '#1d4ed8' } });
      map.on('mouseenter', 'branches-dot', e => {
        const name = String(e.features?.[0]?.properties?.name ?? '');
        if (name && popupRef.current) popupRef.current.setLngLat(e.lngLat).setHTML(name).addTo(map);
      });
      map.on('mouseleave', 'branches-dot', () => popupRef.current?.remove());
    }
  }, [ready, branchRadius]);

  // Первая подгонка под данные (и при смене выборки).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || isConv || !data || data.objects.length === 0) return;
    const b = boundsOf(data.objects);
    if (b) map.fitBounds(b, { padding: 40, maxZoom: 12 });
  }, [ready, data, isConv]);

  const zoomTo = (objs: MapObject[]) => {
    const map = mapRef.current;
    if (!map || objs.length === 0) return;
    if (objs.length === 1) { map.easeTo({ center: [objs[0]!.lon, objs[0]!.lat], zoom: 15 }); return; }
    const b = boundsOf(objs);
    if (b) map.fitBounds(b, { padding: 60 });
  };

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const s = data?.summary;
  const cs = conv?.summary;
  const activeFilters = groups.length + managers.length + depts.length + (buildersOnly ? 1 : 0) + (min ? 1 : 0) + (max ? 1 : 0);

  return (
    <div className={`${fullscreen ? 'fixed inset-0 z-50 bg-[var(--color-bg)]' : 'h-full'} flex flex-col overflow-x-hidden`}>
      {/* ── Шапка ── */}
      <div className="shrink-0 border-b border-[var(--color-border)] px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2">
        <h1 className="text-[15px] font-bold text-[var(--color-text)]">Карта</h1>
        <div className="flex gap-0.5 rounded-lg border border-[var(--color-border)] p-0.5">
          {MODES.map(m => (
            <button key={m.key} type="button" title={m.hint} onClick={() => { setMode(m.key); setSelected(null); }}
              className={`min-h-11 sm:min-h-0 rounded px-2 py-1 text-[11px] font-semibold whitespace-nowrap ${mode === m.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
              {m.label}
            </button>
          ))}
        </div>
        {!isConv && (
          <div className="hidden sm:flex items-center gap-3 text-[11.5px] text-[var(--color-text-muted)]">
            <span>сделок <b className="text-[var(--color-text)] tabular-nums">{s ? s.deals.toLocaleString('ru-RU') : '…'}</b></span>
            <span>на <b className="text-[var(--color-text)] tabular-nums">{s ? fmtMoney(s.sum) : '…'}</b></span>
            <span>объектов <b className="text-[var(--color-text)] tabular-nums">{s ? s.objects.toLocaleString('ru-RU') : '…'}</b></span>
            <span>заказчиков <b className="text-[var(--color-text)] tabular-nums">{s ? s.clients.toLocaleString('ru-RU') : '…'}</b></span>
            <span title="Сделки выборки без адреса или без координат — на карту не попали">без координат <b className="text-[var(--color-text)] tabular-nums">{s ? s.withoutCoords.toLocaleString('ru-RU') : '…'}</b></span>
            {!!s?.pickupDeals && <span title="«Париж» в адресе — самовывоз: точки доставки нет, на карту такие сделки не ставятся">самовывоз <b className="text-[var(--color-text)] tabular-nums">{s.pickupDeals.toLocaleString('ru-RU')}</b></span>}
          </div>
        )}
        {isConv && (
          <div className="hidden sm:flex items-center gap-3 text-[11.5px] text-[var(--color-text-muted)]">
            <span title="Сделки, СОЗДАННЫЕ в периоде, — знаменатель конверсии">сделок создано <b className="text-[var(--color-text)] tabular-nums">{cs ? cs.deals.toLocaleString('ru-RU') : '…'}</b></span>
            <span>CR в продажу <b className="text-[var(--color-text)] tabular-nums">{cs ? `${cs.convSale}%` : '…'}</b></span>
            <span>CR в отгрузку <b className="text-[var(--color-text)] tabular-nums">{cs ? `${cs.convShip}%` : '…'}</b></span>
            <span>квадратов <b className="text-[var(--color-text)] tabular-nums">{cs ? cs.cells.toLocaleString('ru-RU') : '…'}</b></span>
            <span title="Квадраты, где сделок меньше порога — спрятаны, чтобы 0% на двух сделках не выглядел проблемой">скрыто мелких <b className="text-[var(--color-text)] tabular-nums">{cs ? cs.hiddenCells.toLocaleString('ru-RU') : '…'}</b></span>
            {!!cs?.pickupDeals && <span title="«Париж» в адресе — самовывоз: к территории не привязан, в конверсии по районам не участвует">самовывоз <b className="text-[var(--color-text)] tabular-nums">{cs.pickupDeals.toLocaleString('ru-RU')}</b></span>}
          </div>
        )}
        {(isFetching || convFetching) && <Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" />}
        <div className="ml-auto flex items-center gap-1">
          {!isConv && (
            <div className="flex gap-0.5 rounded-lg border border-[var(--color-border)] p-0.5">
              {([['points', 'Точки'], ['heat', 'Тепло'], ['both', 'Оба']] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setLayer(k)}
                  className={`min-h-11 sm:min-h-0 rounded px-2 py-1 text-[11px] font-semibold ${layer === k ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {isConv && (
            <>
              <select value={cellKm} onChange={e => setCellKm(Number(e.target.value))} title="Размер квадрата сетки"
                className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] font-semibold">
                {CELL_KM.map(k => <option key={k} value={k}>квадрат {k} км</option>)}
              </select>
              <select value={minDeals} onChange={e => setMinDeals(Number(e.target.value))}
                title="Сколько сделок должно быть в квадрате, чтобы его показывать: на двух сделках конверсия ничего не значит"
                className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] font-semibold">
                {[3, 5, 10, 20, 50].map(k => <option key={k} value={k}>от {k} сделок</option>)}
              </select>
            </>
          )}
          <select value={branchRadius} onChange={e => setBranchRadius(Number(e.target.value))}
            title="Круги вокруг филиалов — «домашняя зона» доставки"
            className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] font-semibold">
            <option value={0}>без радиусов</option>
            {RADII_KM.map(r => <option key={r} value={r}>радиус {r} км</option>)}
          </select>
          <button type="button" onClick={() => setFiltersOpen(v => !v)}
            className="tap-target sm:hidden rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] font-semibold">
            <SlidersHorizontal size={13} className="inline" />{activeFilters > 0 ? ` ${activeFilters}` : ''}
          </button>
          <button type="button" onClick={() => setFullscreen(v => !v)} title={fullscreen ? 'Свернуть' : 'На весь экран'}
            className="tap-target rounded-lg border border-[var(--color-border)] px-2 py-1">
            {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </div>

      {/* ── Фильтры (на телефоне сворачиваются) ── */}
      <div className={`${filtersOpen ? 'flex' : 'hidden'} sm:flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 sm:px-4 py-2`}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)}
          className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[16px] sm:text-xs" />
        <span className="text-xs text-[var(--color-text-muted)]">—</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)}
          className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[16px] sm:text-xs" />
        {([['Месяц', 1], ['3 мес', 3], ['Год', 12]] as const).map(([label, n]) => (
          <button key={label} type="button" onClick={() => { setFrom(monthAgo(n)); setTo(ymd(new Date())); }}
            className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs font-semibold hover:bg-[var(--color-bg-hover)]">
            {label}
          </button>
        ))}
        <div className="flex gap-0.5 rounded-lg border border-[var(--color-border)] p-0.5">
          {STATES.map(st => (
            <button key={st.key} type="button" title={st.hint} onClick={() => setState(st.key)}
              className={`min-h-11 sm:min-h-0 rounded px-2 py-1 text-[11px] font-semibold whitespace-nowrap ${state === st.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
              {st.label}
            </button>
          ))}
        </div>
        <select value={funnel} onChange={e => setFunnel(e.target.value)}
          className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[16px] sm:text-xs font-semibold">
          {FUNNELS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select value={client} onChange={e => setClient(e.target.value)}
          className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[16px] sm:text-xs font-semibold">
          {CLIENTS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        {/* Явные мультиселекты (правка владельца 21.09: «а фильтровать-то по
            товарным группам как? Точки раскрасил — а толку-то?»). Легенда и
            списки справа остались как быстрые переключатели, но основной,
            заметный способ — вот эти три кнопки в ряду фильтров. Списки
            приходят с сервера по ТЕКУЩЕЙ выборке (с суммами) и не схлопываются
            при выборе: каждый фасет считается без своего же фильтра. */}
        <MultiSelect label="Группы" items={facets.groups.map(g => ({ key: g.group, label: g.group, deals: g.deals, sum: g.sum, color: groupColor.get(g.group) }))}
          selected={groups} onChange={setGroups} searchPlaceholder="Поиск группы" />
        <MultiSelect label="Менеджеры" items={facets.managers.map(m => ({ key: m.id, label: m.name, deals: m.deals, sum: m.sum }))}
          selected={managers} onChange={setManagers} searchPlaceholder="Поиск менеджера" />
        <MultiSelect label="Отделы" items={facets.departments.map(d => ({ key: d.department, label: d.department, deals: d.deals, sum: d.sum }))}
          selected={depts} onChange={setDepts} searchPlaceholder="Поиск отдела" />
        <input value={min} onChange={e => setMin(e.target.value.replace(/\D/g, ''))} placeholder="сумма от" inputMode="numeric"
          className="w-[104px] min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[16px] sm:text-xs" />
        <input value={max} onChange={e => setMax(e.target.value.replace(/\D/g, ''))} placeholder="до" inputMode="numeric"
          className="w-[84px] min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[16px] sm:text-xs" />
        <label className="flex items-center gap-1.5 text-xs font-semibold" title="Только заказчики, которые возят на 2+ разных объекта">
          <input type="checkbox" checked={buildersOnly} onChange={e => setBuildersOnly(e.target.checked)} /> 🏗 строители
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold"
          title="Адреса, на которые по всей базе приходятся сотни сделок, — дефолт формы Битрикса и «просто город». По умолчанию скрыты.">
          <input type="checkbox" checked={withHot} onChange={e => setWithHot(e.target.checked)} /> служебные точки
        </label>
        {activeFilters > 0 && (
          <button type="button" onClick={() => { setGroups([]); setManagers([]); setDepts([]); setMin(''); setMax(''); setBuildersOnly(false); }}
            className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] font-semibold text-[var(--color-text-muted)]">
            сбросить фильтры
          </button>
        )}
      </div>

      {/* Чипы выбранных срезов */}
      {(groups.length > 0 || managers.length > 0 || depts.length > 0) && (
        <div className="shrink-0 flex flex-wrap items-center gap-1.5 px-3 sm:px-4 py-1.5">
          {depts.map(d => <Chip key={d} onClick={() => toggle(depts, d, setDepts)}>{d}</Chip>)}
          {managers.map(m => <Chip key={m} onClick={() => toggle(managers, m, setManagers)}>{facets.managers.find(x => x.id === m)?.name ?? m}</Chip>)}
          {groups.map(g => <Chip key={g} onClick={() => toggle(groups, g, setGroups)}>{g}</Chip>)}
        </div>
      )}

      {!!s?.hiddenServiceDeals && !withHot && (
        <div className="shrink-0 px-3 sm:px-4 pb-1 text-[11px] text-[var(--color-text-muted)]">
          Скрыто <b>{s.hiddenServiceDeals.toLocaleString('ru-RU')}</b> сделок на служебных точках (дефолт формы, «просто город») — включается галкой.
        </div>
      )}
      {s?.truncated && (
        <div className="shrink-0 px-3 sm:px-4 pb-1 text-[11px] text-[var(--color-negative,#e03131)]">
          Выборка упёрлась в потолок 60 000 сделок — сузьте период или фильтры.
        </div>
      )}
      {(isError || convError) && <div className="shrink-0 px-4 pb-1 text-sm text-[var(--color-negative,#e03131)]">Не удалось загрузить данные карты.</div>}
      {isConv && cs?.truncated && (
        <div className="shrink-0 px-3 sm:px-4 pb-1 text-[11px] text-[var(--color-negative,#e03131)]">
          Выборка упёрлась в потолок 80 000 сделок — сузьте период или фильтры.
        </div>
      )}
      {isConv && !!cs?.withoutCoords && (
        <div className="shrink-0 px-3 sm:px-4 pb-1 text-[11px] text-[var(--color-text-muted)]">
          Без пригодного адреса — <b>{cs.withoutCoords.toLocaleString('ru-RU')}</b> сделок выборки: в конверсии по районам они не участвуют.
        </div>
      )}

      {/* ── Карта + панель: тянутся по высоте экрана ── */}
      <div className="min-h-0 flex-1 flex flex-col lg:flex-row gap-2 p-2 sm:p-3">
        <div className="min-h-[320px] flex-1 flex flex-col gap-1.5">
          <div ref={mapEl} className="min-h-0 flex-1 w-full rounded-xl border border-[var(--color-border)] overflow-hidden z-0" />
          {debugOn && (
            <div className="shrink-0 rounded-lg border border-[var(--color-negative,#e03131)] bg-[var(--color-bg-surface)] px-2 py-1 font-mono text-[10.5px] leading-snug text-[var(--color-text)] break-all">
              {dbg}
            </div>
          )}
          {/* Легенда товарных групп — она же фильтр в один клик */}
          {isConv && cs && (
            <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-[var(--color-text-muted)]">
              <span>Цвет — конверсия относительно средней по выборке ({mode === 'conv_sale' ? cs.convSale : cs.convShip}%):</span>
              {([['хуже в 1,7+ раза', '#dc2626'], ['ниже средней', '#f97316'], ['около средней', '#eab308'], ['выше средней', '#84cc16'], ['лучше в 1,4+ раза', '#16a34a']] as const).map(([label, color]) => (
                <span key={label} className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />{label}
                </span>
              ))}
              <span>· насыщенность — сколько сделок в квадрате</span>
            </div>
          )}
          {!isConv && facets.groups.length > 0 && (
            <div className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px]">
              <span className="text-[var(--color-text-muted)]">Цвет — товарная группа, клик по ней фильтрует:</span>
              {facets.groups.slice(0, 8).map(g => {
                const on = groups.includes(g.group);
                return (
                  <button key={g.group} type="button" onClick={() => toggle(groups, g.group, setGroups)}
                    title={`${g.group}: сделок ${g.deals}, ${fmtMoney(g.sum)} — клик фильтрует карту`}
                    className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 ${on
                      ? 'border-[var(--color-accent)] bg-[var(--color-bg-hover)] font-bold text-[var(--color-text)]'
                      : 'border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)]'}`}>
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: groupColor.get(g.group) }} />
                    <span className="max-w-[150px] truncate">{g.group}</span>
                    {on && <Check size={10} />}
                  </button>
                );
              })}
              <span className="flex items-center gap-1 text-[var(--color-text-muted)]">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: OTHER_COLOR }} /> прочее
              </span>
              {groups.length > 0 && (
                <button type="button" onClick={() => setGroups([])} className="text-[var(--color-accent)] hover:underline">сбросить группы</button>
              )}
            </div>
          )}
        </div>

        {/* Панель: справа на десктопе, под картой на телефоне */}
        <div className="lg:w-[380px] shrink-0 min-h-0 flex flex-col gap-2 overflow-y-auto">
          {selected?.kind === 'object' && (
            <ObjectPanel o={selected.object} onClose={() => setSelected(null)} onDeal={setOpenDealId}
              onZoom={() => zoomTo([selected.object])} color={colorOf(selected.object)} />
          )}
          {selected?.kind === 'cluster' && (
            <ClusterPanel objects={selected.objects} onClose={() => setSelected(null)} onDeal={setOpenDealId}
              onZoom={() => zoomTo(selected.objects)} onObject={o => setSelected({ kind: 'object', object: o })} />
          )}
          {selected?.kind === 'cell' && (
            <CellPanel cell={selected.cell} mode={mode} avg={mode === 'conv_sale' ? (cs?.convSale ?? 0) : (cs?.convShip ?? 0)}
              onClose={() => setSelected(null)} onDeal={setOpenDealId}
              onZoom={() => {
                const map = mapRef.current, b = selected.cell.bounds;
                // bounds приходят как [[lat,lon],[lat,lon]], MapLibre ждёт [[lng,lat],[lng,lat]].
                if (map) map.fitBounds([[b[0][1], b[0][0]], [b[1][1], b[1][0]]], { padding: 40 });
              }} />
          )}
          {!selected && (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
              {isConv
                ? 'Квадрат — район. Цвет — конверсия относительно средней по выборке, насыщенность — объём сделок. Клик по квадрату покажет его сделки: какие дошли до продажи, какие нет.'
                : 'Клик по точке — объект и его сделки. Клик по кластеру — все сделки внутри него списком. Цвет точки — ведущая товарная группа объекта.'}
            </div>
          )}
          <FacetList title="Отделы" rows={facets.departments.slice(0, 10).map(d => ({ key: d.department, label: d.department, deals: d.deals, sum: d.sum }))}
            active={depts} onToggle={k => toggle(depts, k, setDepts)} />
          <FacetList title="Менеджеры" rows={facets.managers.slice(0, 12).map(m => ({ key: m.id, label: m.name, deals: m.deals, sum: m.sum }))}
            active={managers} onToggle={k => toggle(managers, k, setManagers)} />
          <FacetList title="Товарные группы" rows={facets.groups.slice(0, 14).map(g => ({ key: g.group, label: g.group, deals: g.deals, sum: g.sum }))}
            active={groups} onToggle={k => toggle(groups, k, setGroups)} color={g => groupColor.get(g)} />
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}

function Chip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-lg bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-text-inverse)]">
      {children} ✕
    </button>
  );
}

function PanelHead({ title, onClose, onZoom }: { title: React.ReactNode; onClose: () => void; onZoom: () => void }) {
  return (
    <div className="flex items-start gap-2">
      <MapPin size={14} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
      <div className="min-w-0 flex-1 text-[12.5px] font-semibold break-words">{title}</div>
      <button onClick={onZoom} title="Приблизить на карте" className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><ZoomIn size={14} /></button>
      <button onClick={onClose} className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X size={14} /></button>
    </div>
  );
}

function GroupBars({ groups, total }: { groups: GroupSlice[]; total: number }) {
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {groups.map(g => (
        <div key={g.group} className="flex items-center gap-2 text-[11.5px]">
          <span className="min-w-0 flex-1 truncate" title={g.group}>{g.group}</span>
          <div className="w-16 h-1.5 shrink-0 rounded bg-[var(--color-bg-hover)] overflow-hidden">
            <div className="h-full bg-[var(--color-accent)]" style={{ width: `${total > 0 ? Math.round((g.sum / total) * 100) : 0}%` }} />
          </div>
          <span className="shrink-0 w-[70px] text-right tabular-nums text-[var(--color-text-muted)]">{fmtMoney(g.sum)}</span>
        </div>
      ))}
    </div>
  );
}

function DealRow({ it, onDeal }: { it: ObjItem; onDeal: (id: number) => void }) {
  return (
    <button onClick={() => onDeal(it.dealId)}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left hover:border-[var(--color-accent)]">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="font-mono font-semibold text-[var(--color-accent)]">#{it.dealId}</span>
        <span className="text-[var(--color-text-muted)]">{fmtDate(it.at)}</span>
        <span className="ml-auto font-semibold tabular-nums">{fmtMoney(it.amount)}</span>
      </div>
      <div className="text-[11px] text-[var(--color-text-muted)] truncate">
        {[it.group, it.manager].filter(Boolean).join(' · ') || it.name || '—'}
      </div>
    </button>
  );
}

/** Панель объекта: состав по группам, сделки и соседи по всей истории. */
function ObjectPanel({ o, onClose, onDeal, onZoom, color }: {
  o: MapObject; onClose: () => void; onDeal: (id: number) => void; onZoom: () => void; color: string;
}) {
  const [radius, setRadius] = useState(1);
  const { data: nb, isFetching } = useQuery<Neighbours>({
    queryKey: ['map-neighbours', o.key, radius],
    queryFn: () => fetch(`/api/map/neighbors?lat=${o.lat}&lon=${o.lon}&r=${radius}&key=${encodeURIComponent(o.key)}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 flex flex-col gap-2">
      <PanelHead title={<span className="flex items-start gap-1.5">
        <span className="mt-1 inline-block w-2.5 h-2.5 shrink-0 rounded-full" style={{ background: color }} />
        {o.address}
      </span>} onClose={onClose} onZoom={onZoom} />
      {o.hot && (
        <div className="rounded-lg bg-[color-mix(in_srgb,var(--color-warning,#d9840c)_12%,transparent)] px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
          Служебная точка: сюда по всей базе попали сотни сделок — это дефолтный адрес формы, а не объект.
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-[11.5px] text-[var(--color-text-muted)]">
        <span>сделок <b className="text-[var(--color-text)]">{o.deals}</b></span>
        <span>на <b className="text-[var(--color-text)]">{fmtMoney(o.sum)}</b></span>
        <span>заказчиков <b className="text-[var(--color-text)]">{o.clients}</b></span>
        <a href={`https://yandex.ru/maps/?pt=${o.lon},${o.lat}&z=17&l=map`} target="_blank" rel="noopener noreferrer"
          className="text-[var(--color-accent)] hover:underline">Яндекс-карта</a>
      </div>

      <Section title="Товарные группы объекта">
        <GroupBars groups={o.groups} total={o.sum} />
      </Section>

      <Section title={`Сделки · ${o.items.length}`}>
        <div className="flex flex-col gap-1 max-h-[34vh] overflow-y-auto">
          {o.items.map(it => <DealRow key={it.dealId} it={it} onDeal={onDeal} />)}
        </div>
      </Section>

      {/* Соседи — по ВСЕЙ истории, а не по фильтру отчёта: вопрос «есть ли тут
          наша поляна», а не «что было в периоде». */}
      <Section title="Соседи по объекту" hint="Что мы возили рядом за всю историю — независимо от фильтров отчёта">
        <div className="flex items-center gap-1 mb-1">
          {[0.5, 1, 3, 10].map(r => (
            <button key={r} type="button" onClick={() => setRadius(r)}
              className={`min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-semibold ${radius === r ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : ''}`}>
              {r} км
            </button>
          ))}
          {isFetching && <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />}
        </div>
        {nb && (
          <>
            <div className="mb-1 text-[11.5px] text-[var(--color-text-muted)]">
              в радиусе {nb.radiusKm} км: объектов <b className="text-[var(--color-text)]">{nb.objects}</b>,
              отгрузок <b className="text-[var(--color-text)]">{nb.deals}</b> на <b className="text-[var(--color-text)]">{fmtMoney(nb.sum)}</b>,
              заказчиков <b className="text-[var(--color-text)]">{nb.clients}</b>
              {nb.lastAt && <> · последняя {fmtDate(nb.lastAt)}</>}
            </div>
            <div className="flex flex-col gap-0.5 max-h-[26vh] overflow-y-auto">
              {nb.items.map(n => (
                <div key={n.key} className="flex items-center gap-2 text-[11.5px]">
                  <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{n.distanceKm} км</span>
                  <span className="min-w-0 flex-1 truncate" title={n.address}>{n.address}</span>
                  <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{n.deals}</span>
                  <span className="shrink-0 w-[70px] text-right tabular-nums">{fmtMoney(n.sum)}</span>
                </div>
              ))}
              {nb.items.length === 0 && <span className="text-[11.5px] text-[var(--color-text-muted)]">Рядом ничего не возили.</span>}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

/** Панель кластера: все объекты и ВСЕ сделки внутри него списком. */
function ClusterPanel({ objects, onClose, onDeal, onZoom, onObject }: {
  objects: MapObject[]; onClose: () => void; onDeal: (id: number) => void; onZoom: () => void; onObject: (o: MapObject) => void;
}) {
  const [tab, setTab] = useState<'objects' | 'deals'>('deals');
  const deals = useMemo(
    () => objects.flatMap(o => o.items.map(it => ({ ...it, address: o.address })))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, 300),
    [objects],
  );
  const sum = objects.reduce((s, o) => s + o.sum, 0);
  const dealsCount = objects.reduce((s, o) => s + o.deals, 0);
  const groups = useMemo(() => {
    const m = new Map<string, { group: string; deals: number; sum: number }>();
    for (const o of objects) {
      for (const g of o.groups) {
        const cur = m.get(g.group) ?? { group: g.group, deals: 0, sum: 0 };
        cur.deals += g.deals; cur.sum += g.sum; m.set(g.group, cur);
      }
    }
    return [...m.values()].sort((a, b) => b.sum - a.sum).slice(0, 6);
  }, [objects]);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 flex flex-col gap-2">
      <PanelHead title={`Кластер · объектов ${objects.length}`} onClose={onClose} onZoom={onZoom} />
      <div className="flex flex-wrap gap-3 text-[11.5px] text-[var(--color-text-muted)]">
        <span>сделок <b className="text-[var(--color-text)]">{dealsCount}</b></span>
        <span>на <b className="text-[var(--color-text)]">{fmtMoney(sum)}</b></span>
      </div>
      <GroupBars groups={groups} total={sum} />
      <div className="flex gap-0.5 rounded-lg border border-[var(--color-border)] p-0.5">
        {([['deals', `Все сделки · ${Math.min(dealsCount, deals.length)}`], ['objects', `Объекты · ${objects.length}`]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`min-h-11 sm:min-h-0 flex-1 rounded px-2 py-1 text-[11.5px] font-semibold ${tab === k ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1 max-h-[52vh] overflow-y-auto">
        {tab === 'deals' && deals.map(it => (
          <button key={it.dealId} onClick={() => onDeal(it.dealId)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left hover:border-[var(--color-accent)]">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-mono font-semibold text-[var(--color-accent)]">#{it.dealId}</span>
              <span className="text-[var(--color-text-muted)]">{fmtDate(it.at)}</span>
              <span className="ml-auto font-semibold tabular-nums">{fmtMoney(it.amount)}</span>
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate" title={it.address}>{it.address}</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">{[it.group, it.manager].filter(Boolean).join(' · ')}</div>
          </button>
        ))}
        {tab === 'objects' && objects.map(o => (
          <button key={o.key} onClick={() => onObject(o)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left hover:border-[var(--color-accent)]">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate" title={o.address}>{o.address}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{o.deals}</span>
              <span className="shrink-0 font-semibold tabular-nums">{fmtMoney(o.sum)}</span>
            </div>
            {o.topGroup && <div className="text-[11px] text-[var(--color-text-muted)] truncate">{o.topGroup}</div>}
          </button>
        ))}
        {dealsCount > deals.length && tab === 'deals' && (
          <div className="px-1 py-1 text-[11px] text-[var(--color-text-muted)]">
            Показаны первые {deals.length} сделок кластера — приблизьте карту, чтобы разбить его на части.
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]" title={hint}>{title}</div>
      {children}
    </div>
  );
}

function FacetList({ title, rows, active, onToggle, color }: {
  title: string;
  rows: { key: string; label: string; deals: number; sum: number }[];
  active: string[];
  onToggle: (key: string) => void;
  color?: (key: string) => string | undefined;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-2.5">
      <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</div>
      <div className="flex flex-col">
        {rows.map(r => (
          <button key={r.key} onClick={() => onToggle(r.key)}
            className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[12px] hover:bg-[var(--color-bg-hover)] ${active.includes(r.key) ? 'bg-[var(--color-bg-hover)] font-semibold' : ''}`}>
            {color && <span className="inline-block w-2 h-2 shrink-0 rounded-full" style={{ background: color(r.key) ?? OTHER_COLOR }} />}
            <span className="min-w-0 flex-1 truncate" title={r.label}>{r.label}</span>
            <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{r.deals}</span>
            <span className="shrink-0 w-[74px] text-right tabular-nums">{fmtMoney(r.sum)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Мультиселект-фильтр на Radix Popover (правило проекта: никаких самописных
 * дропдаунов — на узких экранах они уезжают за край). Список приходит из
 * фасетов текущей выборки: у каждого пункта видно, сколько сделок и денег он
 * даёт, поэтому выбирать можно осмысленно, а не наугад.
 */
function MultiSelect({ label, items, selected, onChange, searchPlaceholder }: {
  label: string;
  items: { key: string; label: string; deals: number; sum: number; color?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder: string;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? items.filter(i => i.label.toLowerCase().includes(needle)) : items;
    // Выбранные держим наверху — иначе при длинном списке не видно, что включено.
    return [...list].sort((a, b) => Number(selected.includes(b.key)) - Number(selected.includes(a.key)));
  }, [items, q, selected]);
  const toggleKey = (k: string) => onChange(selected.includes(k) ? selected.filter(x => x !== k) : [...selected, k]);

  return (
    <Popover
      className="w-[320px] max-w-[calc(100vw-16px)] p-2"
      trigger={
        <button type="button"
          className={`min-h-11 sm:min-h-0 flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold ${
            selected.length > 0
              ? 'border-[var(--color-accent)] bg-[var(--color-bg-hover)] text-[var(--color-text)]'
              : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
          {label}
          {selected.length > 0 && <span className="rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] text-[var(--color-text-inverse)]">{selected.length}</span>}
          <ChevronDown size={12} className="opacity-60" />
        </button>
      }
    >
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={searchPlaceholder}
        className="mb-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-xs" />
      <div className="max-h-[46vh] overflow-y-auto flex flex-col">
        {shown.map(i => {
          const on = selected.includes(i.key);
          return (
            <button key={i.key} type="button" onClick={() => toggleKey(i.key)}
              className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[12px] hover:bg-[var(--color-bg-hover)] ${on ? 'font-semibold' : ''}`}>
              <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'border-[var(--color-border)]'}`}>
                {on && <Check size={10} />}
              </span>
              {i.color && <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: i.color }} />}
              <span className="min-w-0 flex-1 truncate" title={i.label}>{i.label}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{i.deals}</span>
              <span className="shrink-0 w-[70px] text-right tabular-nums">{fmtMoney(i.sum)}</span>
            </button>
          );
        })}
        {shown.length === 0 && <span className="px-1.5 py-2 text-[12px] text-[var(--color-text-muted)]">Ничего не найдено.</span>}
      </div>
      <div className="mt-1.5 flex items-center justify-between border-t border-[var(--color-border)] pt-1.5 text-[11px]">
        <button type="button" onClick={() => onChange(shown.map(i => i.key))} className="text-[var(--color-accent)] hover:underline">выбрать всё{q ? ' найденное' : ''}</button>
        <button type="button" onClick={() => onChange([])} className="text-[var(--color-text-muted)] hover:underline">сбросить</button>
      </div>
    </Popover>
  );
}

/** Панель квадрата конверсии: цифры района и его сделки — что дошло, что нет. */
function CellPanel({ cell, mode, avg, onClose, onDeal, onZoom }: {
  cell: ConvCell; mode: MapMode; avg: number; onClose: () => void; onDeal: (id: number) => void; onZoom: () => void;
}) {
  const [only, setOnly] = useState<'all' | 'lost'>('all');
  const value = mode === 'conv_sale' ? cell.convSale : cell.convShip;
  const num = mode === 'conv_sale' ? cell.sold : cell.delivered;
  const label = mode === 'conv_sale' ? 'CR в продажу' : 'CR в отгрузку';
  const items = only === 'all' ? cell.items : cell.items.filter(i => (mode === 'conv_sale' ? !i.sold : !i.delivered));
  const delta = avg > 0 ? Math.round((value - avg) * 10) / 10 : 0;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 flex flex-col gap-2">
      <PanelHead title={`Район ${cell.lat.toFixed(2)}, ${cell.lon.toFixed(2)}`} onClose={onClose} onZoom={onZoom} />
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[22px] font-bold tabular-nums" style={{ color: convColor(value, avg) }}>{value}%</span>
        <span className="text-[11.5px] text-[var(--color-text-muted)]">
          {label} · {num} из {cell.deals} сделок · средняя по выборке {avg}%
          {delta !== 0 && <b className={delta < 0 ? 'text-[var(--color-negative,#e03131)]' : 'text-[var(--color-positive,#2f9e44)]'}> ({delta > 0 ? '+' : ''}{delta} п.п.)</b>}
        </span>
      </div>
      <div className="flex flex-wrap gap-3 text-[11.5px] text-[var(--color-text-muted)]">
        <span>сумма сделок <b className="text-[var(--color-text)]">{fmtMoney(cell.sum)}</b></span>
        <span>из них продано <b className="text-[var(--color-text)]">{fmtMoney(cell.soldSum)}</b></span>
      </div>

      <Section title="Адреса района">
        <div className="flex flex-col gap-0.5 max-h-[22vh] overflow-y-auto">
          {cell.topAddresses.map(a => (
            <div key={a.address} className="flex items-center gap-2 text-[11.5px]">
              <span className="min-w-0 flex-1 truncate" title={a.address}>{a.address}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{a.sold}/{a.deals}</span>
            </div>
          ))}
        </div>
      </Section>

      <div className="flex gap-0.5 rounded-lg border border-[var(--color-border)] p-0.5">
        {([['all', `Все сделки · ${cell.items.length}`], ['lost', mode === 'conv_sale' ? 'Не продались' : 'Не отгрузились']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setOnly(k)}
            className={`min-h-11 sm:min-h-0 flex-1 rounded px-2 py-1 text-[11.5px] font-semibold ${only === k ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
            {l}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1 max-h-[38vh] overflow-y-auto">
        {items.map(it => (
          <button key={it.dealId} onClick={() => onDeal(it.dealId)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left hover:border-[var(--color-accent)]">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-mono font-semibold text-[var(--color-accent)]">#{it.dealId}</span>
              <span className="text-[var(--color-text-muted)]">создана {fmtDate(it.at)}</span>
              <span className="ml-auto font-semibold tabular-nums">{fmtMoney(it.amount)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <span className={it.delivered ? 'text-[var(--color-positive,#2f9e44)]' : it.sold ? 'text-[var(--color-accent)]' : ''}>
                {it.delivered ? 'отгружена' : it.sold ? 'продана' : 'не дошла'}
              </span>
              <span className="min-w-0 flex-1 truncate">· {[it.group, it.manager].filter(Boolean).join(' · ')}</span>
            </div>
            {it.address && <div className="text-[11px] text-[var(--color-text-muted)] truncate" title={it.address}>{it.address}</div>}
          </button>
        ))}
        {items.length === 0 && <span className="px-1 py-1 text-[11.5px] text-[var(--color-text-muted)]">Пусто.</span>}
      </div>
      {cell.deals > cell.items.length && (
        <div className="text-[11px] text-[var(--color-text-muted)]">Показаны первые {cell.items.length} из {cell.deals} сделок района.</div>
      )}
    </div>
  );
}
