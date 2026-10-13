'use client';
// Поле «Адрес идеальный» (ТЗ владельца 13.10): одно поле, куда вставляют что
// угодно — ссылку на карту, координаты, адрес текстом, — плюс мини-карта с
// точкой, которую можно перетащить. Каскад резолва — lib/geo/resolve.ts.
//
// Главный принцип — геокодеру на слово не верим: точность показывается всегда,
// и если точка стоит хуже, чем «до дома», значение не считается подтверждённым,
// пока человек не поставит точку сам (перетащит / ткнёт в карту) или явно не
// отметит «точка стоит верно». Компонент общий: сначала объекты в модуле
// «Карточка клиента», дальше — окно адреса в сделке (BACKLOG).

import { apiFetch } from '@/lib/client/apiFetch';
import { useCallback, useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapPin, Search, Loader2, ExternalLink, Crosshair } from 'lucide-react';
import { ensureWorkerUrl, osmStyle } from '@/features/map/ui/mapEngine';
import { parseCoords, parseMapUrl, looksLikeUrl } from '@/lib/geo/parse';
import type { GeoCandidate, Precision, ResolveResult } from '@/lib/geo/resolve';

export interface GeoValue extends GeoCandidate {
  /** Точка подтверждена: поставлена человеком/ссылкой/координатами, найдена до
   *  дома, либо человек явно отметил «стоит верно». */
  confirmed: boolean;
}

export interface GeoHint { label: string; lat: number; lon: number }

const PRECISION_UI: Record<Precision, { label: string; tone: 'ok' | 'warn' | 'neg' }> = {
  pin: { label: 'Точка поставлена вручную — точно', tone: 'ok' },
  house: { label: 'Найдено до дома', tone: 'ok' },
  street: { label: 'Найдено только до улицы — уточните точку', tone: 'warn' },
  settlement: { label: 'Найден только населённый пункт — поставьте точку на участок', tone: 'neg' },
  city: { label: 'Найден только город — поставьте точку на объект', tone: 'neg' },
  region: { label: 'Найден только район/область — поставьте точку', tone: 'neg' },
  none: { label: 'Точность неизвестна — поставьте точку', tone: 'neg' },
};
const TONE_COLOR = { ok: 'var(--color-positive, #2f9e44)', warn: 'var(--color-warning, #e8590c)', neg: 'var(--color-negative, #e03131)' };
const ZOOM: Record<Precision, number> = { pin: 17, house: 17, street: 15, settlement: 13, city: 11, region: 8, none: 10 };

const SOURCE_LABEL: Record<GeoCandidate['source'], string> = {
  link: 'по ссылке на карту', coords: 'по координатам', dadata: 'DaData', osm: 'OpenStreetMap', manual: 'точка на карте',
};

const isSure = (p: Precision) => p === 'pin' || p === 'house';
const toValue = (c: GeoCandidate): GeoValue => ({ ...c, confirmed: isSure(c.precision) });

async function reverse(lat: number, lon: number): Promise<GeoCandidate | null> {
  const r = await apiFetch(`/api/geo/reverse?lat=${lat}&lon=${lon}`);
  if (!r.ok) return null;
  return (await r.json()).candidate ?? null;
}

// ── Мини-карта с перетаскиваемой точкой ──────────────────────────────────────

function MiniMap({ value, onPick }: { value: GeoValue | null; onPick: (lat: number, lon: number) => void }) {
  const el = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  const markerRef = useRef<import('maplibre-gl').Marker | null>(null);
  const mlRef = useRef<typeof import('maplibre-gl') | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import('maplibre-gl');
      const M = (mod as unknown as { default?: typeof mod }).default ?? mod;
      ensureWorkerUrl(M);
      if (cancelled || !el.current || mapRef.current) return;
      const map = new M.Map({
        container: el.current, style: osmStyle() as never, center: [37.62, 55.75], zoom: 4,
        attributionControl: { compact: true }, cooperativeGestures: true,
      });
      map.addControl(new M.NavigationControl({ showCompass: false }), 'top-right');
      map.on('click', e => pickRef.current(e.lngLat.lat, e.lngLat.lng));
      mapRef.current = map;
      mlRef.current = M;
      setReady(true);
    })();
    return () => { cancelled = true; markerRef.current?.remove(); mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current, M = mlRef.current;
    if (!ready || !map || !M) return;
    if (!value) { markerRef.current?.remove(); markerRef.current = null; return; }
    if (!markerRef.current) {
      const m = new M.Marker({ draggable: true, color: '#e03131' }).setLngLat([value.lon, value.lat]).addTo(map);
      m.on('dragend', () => { const p = m.getLngLat(); pickRef.current(p.lat, p.lng); });
      markerRef.current = m;
    } else {
      markerRef.current.setLngLat([value.lon, value.lat]);
    }
    map.easeTo({ center: [value.lon, value.lat], zoom: Math.max(map.getZoom(), ZOOM[value.precision]), duration: 400 });
  }, [ready, value]);

  return (
    <div className="relative h-56 w-full overflow-hidden rounded-lg border border-[var(--color-border)] sm:h-64">
      {/* Не absolute: maplibre-gl.css ставит контейнеру position: relative — высота схлопнулась бы в 0. */}
      <div ref={el} className="h-full w-full" />
      {!value && (
        <div className="pointer-events-none absolute left-2 right-12 top-2 w-fit max-w-[calc(100%-4rem)] rounded-md bg-[var(--color-bg-surface)]/90 px-2 py-1 text-center text-[11.5px] text-[var(--color-text-muted)]">
          Найдите адрес или ткните в карту, чтобы поставить точку
        </div>
      )}
    </div>
  );
}

// ── Поле ─────────────────────────────────────────────────────────────────────

export function AddressPicker({ value, onChange, hints = [], seedQuery }: {
  value: GeoValue | null;
  onChange: (v: GeoValue | null) => void;
  /** Готовые точки (например, координаты из заявок 1С) — выбрать одним нажатием. */
  hints?: GeoHint[];
  /** Адрес, который можно отправить в поиск одной кнопкой (адрес из заявки 1С). */
  seedQuery?: string | null;
}) {
  const [text, setText] = useState('');
  const [suggest, setSuggest] = useState<GeoCandidate[]>([]);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const seq = useRef(0);
  /** Текст, подставленный программно (выбор подсказки, «Найти адрес из заявки») — подсказки по нему не нужны. */
  const quietText = useRef<string | null>(null);

  // Подсказки при наборе — только для текста (ссылку/координаты разбираем сразу).
  useEffect(() => {
    const q = text.trim();
    if (q.length < 3 || looksLikeUrl(q) || parseCoords(q) || text === quietText.current) { setSuggest([]); return; }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      const r = await apiFetch(`/api/geo/suggest?q=${encodeURIComponent(q)}`).then(x => x.json()).catch(() => null);
      if (my === seq.current) setSuggest(r?.candidates ?? []);
    }, 350);
    return () => clearTimeout(t);
  }, [text]);

  const resolve = useCallback(async (input: string) => {
    const q = input.trim();
    if (!q) return;
    seq.current++; quietText.current = input; setSuggest([]); setBusy(true); setResult(null);
    try {
      const r: ResolveResult = await apiFetch('/api/geo/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: q }),
      }).then(x => x.json());
      setResult(r);
      if (r.candidates.length === 1 || (r.candidates[0] && isSure(r.candidates[0].precision))) onChange(toValue(r.candidates[0]));
    } finally { setBusy(false); }
  }, [onChange]);

  const pick = useCallback(async (lat: number, lon: number) => {
    // Точка, поставленная человеком, — истина; адрес под ней — справочно.
    onChange({ lat, lon, address: value?.address ?? `${lat.toFixed(6)}, ${lon.toFixed(6)}`, settlement: value?.settlement ?? null, area: value?.area ?? null, region: value?.region ?? null, precision: 'pin', source: 'manual', confirmed: true });
    setPinBusy(true);
    const c = await reverse(lat, lon).catch(() => null);
    setPinBusy(false);
    if (c) onChange({ ...c, lat, lon, precision: 'pin', source: 'manual', confirmed: true });
  }, [onChange, value]);

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (looksLikeUrl(pasted) || parseCoords(pasted) || parseMapUrl(pasted)) {
      e.preventDefault(); setText(pasted); void resolve(pasted);
    }
  };

  const ui = value ? PRECISION_UI[value.precision] : null;

  return (
    <div className="flex flex-col gap-2">
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void resolve(text); }}>
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={text} onChange={e => setText(e.target.value)} onPaste={onPaste}
            placeholder="Ссылка на карту, координаты или адрес"
            className="h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-base outline-none focus:border-[var(--color-accent)] sm:text-sm" />
        </div>
        <button type="submit" disabled={!text.trim() || busy}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 text-sm font-semibold disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : 'Найти'}
        </button>
      </form>

      {/* Подсказки и кандидаты — списком под полем (не всплывашкой: правило 4). */}
      {suggest.length > 0 && (
        <div className="flex flex-col overflow-hidden rounded-lg border border-[var(--color-border)]">
          {suggest.map((c, i) => (
            <button key={i} type="button" onClick={() => { seq.current++; quietText.current = c.address; setSuggest([]); setText(c.address); setResult(null); onChange(toValue(c)); }}
              className="min-h-10 border-b border-[var(--color-border)] px-3 py-1.5 text-left text-[12.5px] last:border-b-0 hover:bg-[var(--color-bg-hover)]">
              {c.address}
            </button>
          ))}
        </div>
      )}
      {result && result.candidates.length > 1 && (
        <div className="rounded-lg border border-[var(--color-border)] p-2">
          <div className="mb-1 text-[11.5px] text-[var(--color-text-muted)]">Нашлось несколько мест — выберите нужное (проверьте область):</div>
          <div className="flex flex-col gap-1">
            {result.candidates.map((c, i) => (
              <button key={i} type="button" onClick={() => onChange(toValue(c))}
                className={`min-h-10 rounded-md border px-2.5 py-1.5 text-left text-[12.5px] ${value && value.lat === c.lat && value.lon === c.lon ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
                <div className="break-words">{c.address}</div>
                <div className="text-[11px]" style={{ color: TONE_COLOR[PRECISION_UI[c.precision].tone] }}>
                  {c.region ? <b className="text-[var(--color-text)]">{c.region}</b> : null}{c.region ? ' · ' : ''}{PRECISION_UI[c.precision].label.split(' — ')[0]}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      {result?.note && <div className="text-[12px]" style={{ color: 'var(--color-negative, #e03131)' }}>{result.note}</div>}

      {(hints.length > 0 || seedQuery) && (
        <div className="flex flex-wrap gap-1.5">
          {hints.map((h, i) => (
            <button key={i} type="button" onClick={() => void pick(h.lat, h.lon)}
              className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 text-[12px]">
              <Crosshair size={12} /> {h.label}
            </button>
          ))}
          {seedQuery && (
            <button type="button" onClick={() => { quietText.current = seedQuery; setText(seedQuery); void resolve(seedQuery); }}
              className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 text-[12px]">
              <Search size={12} className="shrink-0" /> <span className="truncate">Найти адрес из заявки</span>
            </button>
          )}
        </div>
      )}

      <MiniMap value={value} onPick={(lat, lon) => void pick(lat, lon)} />

      {value && ui && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12.5px]">
          <div className="flex items-start gap-1.5">
            <MapPin size={14} className="mt-0.5 shrink-0" style={{ color: TONE_COLOR[ui.tone] }} />
            <span className="min-w-0 flex-1 break-words font-medium">{pinBusy ? 'Определяем адрес точки…' : value.address}</span>
          </div>
          <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
            {[value.settlement && `Нас. пункт: ${value.settlement}`, value.area, value.region].filter(Boolean).join(' · ') || 'Населённый пункт не определён'}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
            <span className="font-semibold" style={{ color: TONE_COLOR[ui.tone] }}>{ui.label}</span>
            <span className="text-[var(--color-text-muted)] tabular-nums">{value.lat.toFixed(6)}, {value.lon.toFixed(6)} · {SOURCE_LABEL[value.source]}</span>
            <a href={`https://yandex.ru/maps/?pt=${value.lon},${value.lat}&z=17&l=map`} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline">
              Яндекс Карты <ExternalLink size={11} />
            </a>
          </div>
          {!isSure(value.precision) && (
            <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={value.confirmed} onChange={e => onChange({ ...value, confirmed: e.target.checked })} className="accent-[var(--color-accent)]" />
              Точка стоит верно (или перетащите её на карте)
            </label>
          )}
        </div>
      )}
    </div>
  );
}
