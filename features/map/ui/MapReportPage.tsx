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
//   • тепловая карта (leaflet.heat) — включается поверх или вместо точек;
//   • круги радиусов вокруг филиалов (25/50/100 км) — «домашняя зона»;
//   • «соседи» выбранного объекта по ВСЕЙ истории (/api/map/neighbors) —
//     749 кустов с 3+ заказчиками дают больше половины выручки, это рабочий
//     инструмент, а не украшение;
//   • раскладка по высоте экрана (h-dvh, карта тянется) + режим «на весь
//     экран»; на телефоне панель уезжает под карту.
//
// Карта — Leaflet + OSM-тайлы. Библиотеки грузятся динамически в эффекте: они
// лезут к window и на сервере не живут.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { MapPin, Loader2, X, Maximize2, Minimize2, SlidersHorizontal, ZoomIn, ChevronDown, Check } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { GS_BASE_ROW, mixHex } from '@/lib/colors/google-sheets-palette';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

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
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const pointsRef = useRef<import('leaflet').LayerGroup | null>(null);
  const heatRef = useRef<import('leaflet').Layer | null>(null);
  const circlesRef = useRef<import('leaflet').LayerGroup | null>(null);
  const cellsRef = useRef<import('leaflet').LayerGroup | null>(null);
  const [leaflet, setLeaflet] = useState<typeof import('leaflet') | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default ?? (await import('leaflet'));
      await import('leaflet.markercluster');
      await import('leaflet.heat');
      if (cancelled || !mapEl.current || mapRef.current) return;
      const map = L.map(mapEl.current, { center: [59.94, 30.31], zoom: 6, preferCanvas: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      mapRef.current = map;
      setLeaflet(L);
    })();
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  // Масштабирование под размер экрана (правка владельца): при любом изменении
  // размеров контейнера — полноэкранный режим, поворот телефона, свёрнутые
  // фильтры — Leaflet обязан пересчитать вьюпорт, иначе половина карты серая.
  useEffect(() => {
    const el = mapEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { mapRef.current?.invalidateSize(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 60);
    return () => clearTimeout(t);
  }, [fullscreen, filtersOpen, selected]);

  // Точки + кластеры
  useEffect(() => {
    const L = leaflet;
    const map = mapRef.current;
    if (!L || !map || !data) return;
    if (pointsRef.current) { map.removeLayer(pointsRef.current); pointsRef.current = null; }
    if (layer === 'heat' || isConv) return;

    const cluster = (L as unknown as { markerClusterGroup: (o: object) => import('leaflet').LayerGroup & { on: (e: string, cb: (x: { layer: { getAllChildMarkers: () => unknown[] } }) => void) => void } })
      .markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 50,
        // Клик по кластеру не улетает в зум (правка владельца: «кликать на
        // кластер и видеть все сделки там списком») — зум отдельной кнопкой.
        zoomToBoundsOnClick: false,
        spiderfyOnMaxZoom: false,
        iconCreateFunction: (c: { getChildCount: () => number }) => {
          const n = c.getChildCount();
          const size = n < 10 ? 34 : n < 100 ? 42 : 52;
          return L.divIcon({
            html: `<div style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:999px;background:rgba(37,99,235,.85);color:#fff;font-weight:700;font-size:${n < 100 ? 13 : 12}px;border:2px solid rgba(255,255,255,.9)">${n}</div>`,
            className: '', iconSize: [size, size],
          });
        },
      });

    const maxSum = Math.max(1, ...data.objects.map(o => o.sum));
    for (const o of data.objects) {
      const r = 5 + Math.round(9 * Math.sqrt(o.sum / maxSum));
      const color = colorOf(o);
      const m = L.circleMarker([o.lat, o.lon], { radius: r, weight: 1, color: mixHex(color, '#000000', 0.25), fillColor: color, fillOpacity: 0.8 });
      (m as unknown as { __obj: MapObject }).__obj = o;
      m.bindTooltip(
        `${o.address}<br><b>${fmtMoney(o.sum)}</b> · сделок ${o.deals}${o.topGroup ? `<br>${o.topGroup}` : ''}${o.hot ? '<br><i>служебная точка: дефолтный адрес, не объект</i>' : ''}`,
        { direction: 'top' },
      );
      m.on('click', () => setSelected({ kind: 'object', object: o }));
      cluster.addLayer(m);
    }
    cluster.on('clusterclick', (e: { layer: { getAllChildMarkers: () => unknown[] } }) => {
      const objs = e.layer.getAllChildMarkers()
        .map(m => (m as { __obj?: MapObject }).__obj)
        .filter((o): o is MapObject => !!o)
        .sort((a, b) => b.sum - a.sum);
      setSelected({ kind: 'cluster', objects: objs });
    });
    map.addLayer(cluster);
    pointsRef.current = cluster;
  }, [leaflet, data, layer, colorOf, isConv]);

  // Тепловая карта: вес точки — деньги, поэтому «горячо» там, где выручка, а
  // не там, где просто много мелких отгрузок.
  useEffect(() => {
    const L = leaflet as unknown as { heatLayer?: (pts: [number, number, number][], o: object) => import('leaflet').Layer };
    const map = mapRef.current;
    if (!leaflet || !map || !data) return;
    if (heatRef.current) { map.removeLayer(heatRef.current); heatRef.current = null; }
    if (layer === 'points' || isConv || !L.heatLayer) return;
    const maxSum = Math.max(1, ...data.objects.map(o => o.sum));
    const pts = data.objects.map(o => [o.lat, o.lon, Math.max(0.15, o.sum / maxSum)] as [number, number, number]);
    const heat = L.heatLayer(pts, { radius: 26, blur: 20, maxZoom: 12, minOpacity: 0.25 });
    heat.addTo(map);
    heatRef.current = heat;
  }, [leaflet, data, layer, isConv]);

  // Квадраты конверсии (правка владельца 21.09: «где территориально у меня
  // самая низкая конверсия?»). Считаем не по объекту — по одному адресу с
  // двумя сделками конверсия всегда 0% или 100%, это шум, — а по квадратам
  // сетки с порогом по числу сделок. Цвет — относительно СРЕДНЕЙ конверсии
  // текущей выборки: «хуже, чем обычно у этого товара», а не по абсолютной
  // шкале, где утеплитель и щебень несравнимы.
  useEffect(() => {
    const L = leaflet;
    const map = mapRef.current;
    if (!L || !map) return;
    if (cellsRef.current) { map.removeLayer(cellsRef.current); cellsRef.current = null; }
    if (!isConv || !conv) return;

    const avg = mode === 'conv_sale' ? conv.summary.convSale : conv.summary.convShip;
    const maxDeals = Math.max(1, ...conv.cells.map(c => c.deals));
    const g = L.layerGroup();
    for (const c of conv.cells) {
      const value = mode === 'conv_sale' ? c.convSale : c.convShip;
      const color = convColor(value, avg);
      // Прозрачность по объёму: квадрат на 5 сделках не должен кричать так же,
      // как квадрат на 200 — иначе «проблема» найдётся там, где просто мало данных.
      const opacity = 0.25 + 0.45 * Math.sqrt(c.deals / maxDeals);
      const rect = L.rectangle(c.bounds, { color, weight: 1, fillColor: color, fillOpacity: opacity });
      rect.bindTooltip(
        `${mode === 'conv_sale' ? 'CR в продажу' : 'CR в отгрузку'}: <b>${value}%</b>` +
        `<br>${mode === 'conv_sale' ? c.sold : c.delivered} из ${c.deals} сделок` +
        `<br>средняя по выборке ${avg}%`,
        { direction: 'top' },
      );
      rect.on('click', () => setSelected({ kind: 'cell', cell: c }));
      g.addLayer(rect);
    }
    g.addTo(map);
    cellsRef.current = g;
    if (conv.cells.length > 0) {
      const b = L.latLngBounds(conv.cells.flatMap(c => [c.bounds[0], c.bounds[1]] as [number, number][]));
      map.fitBounds(b.pad(0.1), { maxZoom: 11 });
    }
  }, [leaflet, conv, isConv, mode]);

  // Круги «домашней зоны» вокруг филиалов.
  useEffect(() => {
    const L = leaflet;
    const map = mapRef.current;
    if (!L || !map) return;
    if (circlesRef.current) { map.removeLayer(circlesRef.current); circlesRef.current = null; }
    if (!branchRadius) return;
    const g = L.layerGroup();
    for (const b of BRANCHES) {
      L.circle([b.lat, b.lon], {
        radius: branchRadius * 1000, color: '#1d4ed8', weight: 1, dashArray: '4 4', fill: false, interactive: false,
      }).addTo(g);
      L.circleMarker([b.lat, b.lon], { radius: 4, color: '#1d4ed8', fillColor: '#1d4ed8', fillOpacity: 1 })
        .bindTooltip(`${b.name} · радиус ${branchRadius} км`, { direction: 'top' }).addTo(g);
    }
    g.addTo(map);
    circlesRef.current = g;
  }, [leaflet, branchRadius]);

  // Первая подгонка под данные (и при смене выборки).
  useEffect(() => {
    const L = leaflet;
    const map = mapRef.current;
    if (!L || !map || isConv || !data || data.objects.length === 0) return;
    const b = L.latLngBounds(data.objects.map(o => [o.lat, o.lon] as [number, number]));
    map.fitBounds(b.pad(0.1), { maxZoom: 12 });
  }, [leaflet, data, isConv]);

  const zoomTo = (objs: MapObject[]) => {
    const L = leaflet, map = mapRef.current;
    if (!L || !map || objs.length === 0) return;
    if (objs.length === 1) map.setView([objs[0]!.lat, objs[0]!.lon], 15);
    else map.fitBounds(L.latLngBounds(objs.map(o => [o.lat, o.lon] as [number, number])).pad(0.15));
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
              onZoom={() => { const map = mapRef.current; if (map) map.fitBounds(selected.cell.bounds as unknown as [[number, number], [number, number]]); }} />
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
