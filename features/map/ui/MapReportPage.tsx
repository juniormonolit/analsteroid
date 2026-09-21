'use client';
// Спец-отчёт «Карта объектов» (задача владельца 21.09: «хочу спецотчет в „Ещё“,
// чтобы там можно было на карте смотреть все. Крутецкий отчет со всеми
// стандартными фильтрами логикой дриллдауна и так далее»).
//
// Точка на карте = ОБЪЕКТ (адрес доставки), а не сделка: на один адрес часто
// возят несколько раз, и «3 сделки на 1,2 млн» читается лучше трёх меток друг
// на друге. Клик по объекту → список его сделок → карточка сделки (тот же
// DealCard, что в отчётах). Фильтры серверные, срезы-факты (менеджеры, группы,
// отделы) считаются по текущей выборке и работают как фильтры в один клик.
//
// Карта — Leaflet + OSM-тайлы, кластеризация leaflet.markercluster. Библиотека
// грузится динамически в эффекте: она лезет к window и на сервере не живёт.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { MapPin, Loader2, X } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });

interface ObjItem { dealId: number; amount: number; at: string | null; manager: string | null; group: string | null; name: string | null }
interface MapObject { key: string; lat: number; lon: number; address: string; deals: number; sum: number; clients: number; items: ObjItem[] }
interface Facets {
  managers: { id: string; name: string; department: string | null; deals: number; sum: number }[];
  groups: { group: string; deals: number; sum: number }[];
  departments: { department: string; deals: number; sum: number }[];
}
interface MapData {
  objects: MapObject[];
  summary: { deals: number; sum: number; objects: number; clients: number; withoutCoords: number; shown: number; truncated: boolean };
  facets: Facets;
}

const STATES: { key: string; label: string; hint: string }[] = [
  { key: 'delivered', label: 'Отгрузки', hint: 'Сделки, отгруженные в периоде (дата отгрузки)' },
  { key: 'sold', label: 'Продажи', hint: 'Сделки, проданные в периоде (дата продажи)' },
  { key: 'active', label: 'В работе', hint: 'Не проданы, не отгружены, не отказ — созданные в периоде' },
  { key: 'lost', label: 'Отказы', hint: 'Сделки, ушедшие в отказ в периоде' },
  { key: 'all', label: 'Все', hint: 'Любые сделки по выбранной базе даты' },
];
const FUNNELS = [
  { key: 'all', label: 'Все воронки' },
  { key: 'primary', label: 'Первичные' },
  { key: 'repeat', label: 'Повторные' },
];
const CLIENTS = [
  { key: 'all', label: 'ЮЛ и ФЛ' },
  { key: 'company', label: 'Юрлица' },
  { key: 'contact', label: 'Физлица' },
];

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function monthAgo(n: number): string { const d = new Date(); d.setMonth(d.getMonth() - n); return ymd(d); }
function fmtMoney(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1_000).toLocaleString('ru-RU')} тыс ₽`;
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
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
  const [selected, setSelected] = useState<MapObject | null>(null);
  const [openDealId, setOpenDealId] = useState<number | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`, state, funnel, client });
    if (groups.length) p.set('groups', groups.join(','));
    if (managers.length) p.set('managers', managers.join(','));
    if (depts.length) p.set('depts', depts.join(','));
    if (min) p.set('min', min);
    if (max) p.set('max', max);
    if (buildersOnly) p.set('builders', '1');
    return p.toString();
  }, [from, to, state, funnel, client, groups, managers, depts, min, max, buildersOnly]);

  const { data, isFetching, isError } = useQuery<MapData>({
    queryKey: ['map-points', qs],
    queryFn: () => fetch(`/api/map/points?${qs}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });

  // ── Карта ────────────────────────────────────────────────────────────────
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const layerRef = useRef<import('leaflet').LayerGroup | null>(null);
  const [leaflet, setLeaflet] = useState<typeof import('leaflet') | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default ?? (await import('leaflet'));
      await import('leaflet.markercluster');
      if (cancelled || !mapEl.current || mapRef.current) return;
      const map = L.map(mapEl.current, { center: [59.94, 30.31], zoom: 6, preferCanvas: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap',
      }).addTo(map);
      mapRef.current = map;
      setLeaflet(L);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Перерисовка точек при смене выборки. Кластеры взвешены по СУММЕ: крупный
  // объект должен быть заметен, а не растворяться среди мелких.
  useEffect(() => {
    const L = leaflet;
    const map = mapRef.current;
    if (!L || !map || !data) return;
    if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null; }

    const cluster = (L as unknown as { markerClusterGroup: (o: object) => import('leaflet').LayerGroup }).markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 50,
      iconCreateFunction: (c: { getAllChildMarkers: () => { options: { title?: string } }[]; getChildCount: () => number }) => {
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
      const m = L.circleMarker([o.lat, o.lon], {
        radius: r, weight: 1, color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 0.75,
      });
      m.bindTooltip(`${o.address}<br><b>${fmtMoney(o.sum)}</b> · сделок ${o.deals}`, { direction: 'top' });
      m.on('click', () => setSelected(o));
      cluster.addLayer(m);
    }
    map.addLayer(cluster);
    layerRef.current = cluster;

    if (data.objects.length > 0) {
      const b = L.latLngBounds(data.objects.map(o => [o.lat, o.lon] as [number, number]));
      map.fitBounds(b.pad(0.1), { maxZoom: 12 });
    }
  }, [leaflet, data]);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const s = data?.summary;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto w-full max-w-[1600px] p-3 sm:p-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-lg font-bold text-[var(--color-text)]">Карта объектов</h1>
          <span className="text-xs text-[var(--color-text-muted)]">
            адрес доставки из Битрикса · точка = объект, размер и число — деньги и сделки
          </span>
        </div>

        {/* ── Фильтры ── */}
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-xs" />
            <span className="text-xs text-[var(--color-text-muted)]">—</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-xs" />
            <div className="flex gap-1">
              {([['Месяц', 1], ['3 месяца', 3], ['Год', 12]] as const).map(([label, n]) => (
                <button key={label} type="button" onClick={() => { setFrom(monthAgo(n)); setTo(ymd(new Date())); }}
                  className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs font-semibold hover:bg-[var(--color-bg-hover)]">
                  {label}
                </button>
              ))}
            </div>
            <div className="flex gap-1 rounded-xl border border-[var(--color-border)] p-0.5">
              {STATES.map(st => (
                <button key={st.key} type="button" title={st.hint} onClick={() => setState(st.key)}
                  className={`min-h-11 sm:min-h-0 rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${state === st.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
                  {st.label}
                </button>
              ))}
            </div>
            <select value={funnel} onChange={e => setFunnel(e.target.value)}
              className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-xs font-semibold">
              {FUNNELS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <select value={client} onChange={e => setClient(e.target.value)}
              className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-xs font-semibold">
              {CLIENTS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <input value={min} onChange={e => setMin(e.target.value.replace(/\D/g, ''))} placeholder="сумма от"
              inputMode="numeric"
              className="w-[110px] min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-xs" />
            <input value={max} onChange={e => setMax(e.target.value.replace(/\D/g, ''))} placeholder="до"
              inputMode="numeric"
              className="w-[90px] min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-xs" />
            <label className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]"
              title="Только заказчики, которые возят на 2+ разных объекта">
              <input type="checkbox" checked={buildersOnly} onChange={e => setBuildersOnly(e.target.checked)} />
              🏗 только строители
            </label>
            {isFetching && <Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" />}
          </div>

          {/* Выбранные срезы — чипами, снимаются кликом */}
          {(groups.length > 0 || managers.length > 0 || depts.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {depts.map(d => (
                <button key={d} onClick={() => toggle(depts, d, setDepts)} className="rounded-lg bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-text-inverse)]">
                  {d} ✕
                </button>
              ))}
              {managers.map(m => (
                <button key={m} onClick={() => toggle(managers, m, setManagers)} className="rounded-lg bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-text-inverse)]">
                  {data?.facets.managers.find(x => x.id === m)?.name ?? m} ✕
                </button>
              ))}
              {groups.map(g => (
                <button key={g} onClick={() => toggle(groups, g, setGroups)} className="rounded-lg bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-text-inverse)]">
                  {g} ✕
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Итоги ── */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { label: 'Сделок', value: s ? s.deals.toLocaleString('ru-RU') : '…', hint: 'Сделок в выборке, у которых есть координаты объекта' },
            { label: 'Сумма', value: s ? fmtMoney(s.sum) : '…', hint: 'Сумма сделок на карте' },
            { label: 'Объектов', value: s ? s.objects.toLocaleString('ru-RU') : '…', hint: 'Разных адресов доставки' },
            { label: 'Заказчиков', value: s ? s.clients.toLocaleString('ru-RU') : '…', hint: 'Разных заказчиков на этих объектах' },
            { label: 'Без координат', value: s ? s.withoutCoords.toLocaleString('ru-RU') : '…', hint: 'Сделки выборки, у которых адрес не заполнен или без координат — на карту не попали' },
          ].map(t => (
            <div key={t.label} title={t.hint} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2">
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-muted)]">{t.label}</div>
              <div className="text-[17px] font-bold tabular-nums text-[var(--color-text)]">{t.value}</div>
            </div>
          ))}
        </div>
        {s?.truncated && (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-hover)] px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]">
            Выборка упёрлась в потолок (60 000 сделок) — сузьте период или фильтры, иначе часть объектов не показана.
          </div>
        )}
        {isError && <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось загрузить данные карты.</div>}

        {/* ── Карта + дрилл ── */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-3">
          <div ref={mapEl} className="h-[52vh] lg:h-[70vh] w-full rounded-xl border border-[var(--color-border)] overflow-hidden z-0" />
          <div className="flex flex-col gap-3 min-w-0">
            {selected ? (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <MapPin size={14} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
                  <div className="min-w-0 flex-1 text-[12.5px] font-semibold break-words">{selected.address}</div>
                  <button onClick={() => setSelected(null)} className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X size={14} /></button>
                </div>
                <div className="flex flex-wrap gap-3 text-[11.5px] text-[var(--color-text-muted)]">
                  <span>сделок <b className="text-[var(--color-text)]">{selected.deals}</b></span>
                  <span>на <b className="text-[var(--color-text)]">{fmtMoney(selected.sum)}</b></span>
                  <span>заказчиков <b className="text-[var(--color-text)]">{selected.clients}</b></span>
                  <a href={`https://yandex.ru/maps/?pt=${selected.lon},${selected.lat}&z=17&l=map`} target="_blank" rel="noopener noreferrer"
                    className="text-[var(--color-accent)] hover:underline">на Яндекс-карте</a>
                </div>
                <div className="flex flex-col gap-1 max-h-[46vh] overflow-y-auto">
                  {selected.items.map(it => (
                    <button key={it.dealId} onClick={() => setOpenDealId(it.dealId)}
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
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-4 text-[12px] text-[var(--color-text-muted)]">
                Клик по точке — сделки этого объекта. Клик по сделке — карточка.
              </div>
            )}

            {/* Срезы по текущей выборке — они же фильтры в один клик */}
            <FacetList title="Отделы" rows={(data?.facets.departments ?? []).slice(0, 10).map(d => ({ key: d.department, label: d.department, deals: d.deals, sum: d.sum }))}
              active={depts} onToggle={k => toggle(depts, k, setDepts)} />
            <FacetList title="Менеджеры" rows={(data?.facets.managers ?? []).slice(0, 12).map(m => ({ key: m.id, label: m.name, deals: m.deals, sum: m.sum }))}
              active={managers} onToggle={k => toggle(managers, k, setManagers)} />
            <FacetList title="Товарные группы" rows={(data?.facets.groups ?? []).slice(0, 12).map(g => ({ key: g.group, label: g.group, deals: g.deals, sum: g.sum }))}
              active={groups} onToggle={k => toggle(groups, k, setGroups)} />
          </div>
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}

function FacetList({ title, rows, active, onToggle }: {
  title: string;
  rows: { key: string; label: string; deals: number; sum: number }[];
  active: string[];
  onToggle: (key: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-2.5">
      <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</div>
      <div className="flex flex-col">
        {rows.map(r => (
          <button key={r.key} onClick={() => onToggle(r.key)}
            className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[12px] hover:bg-[var(--color-bg-hover)] ${active.includes(r.key) ? 'bg-[var(--color-bg-hover)] font-semibold' : ''}`}>
            <span className="min-w-0 flex-1 truncate" title={r.label}>{r.label}</span>
            <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{r.deals}</span>
            <span className="shrink-0 w-[74px] text-right tabular-nums">{fmtMoney(r.sum)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
