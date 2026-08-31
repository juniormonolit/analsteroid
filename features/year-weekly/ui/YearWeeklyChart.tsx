'use client';
import { useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceArea,
} from 'recharts';
import { X, Thermometer, MessageSquareText } from 'lucide-react';
import { type EntityKey, type EntityMetrics, type YearWeeklyResult } from '@/features/year-weekly/shared';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';

// Интерактивный график отчёта «Данные по годам» (задача владельца 28.08: «строй
// охуенный интерактивный график на весь экран… все основные сущности (сделки,
// средний чек, температуру по оф. метеоданным), фильтровать по отделам,
// наводиться на каждую неделю, читать комментарии… чтобы можно было залипать и
// искать инсайты»).
//
// Данные НЕ запрашиваются заново: всё уже пришло в /api/year-weekly для таблицы
// (недели с метриками текущего и прошлого года + погода). График — другой взгляд
// на тот же payload, поэтому переключение метрик и отделов мгновенное.

type ChartMetric = 'deals' | 'salesSum' | 'shipSum' | 'crSale' | 'crShip' | 'avgCheck';
const METRIC_DEFS: { key: ChartMetric; label: string; kind: 'count' | 'money' | 'pct' }[] = [
  { key: 'deals', label: 'Кол-во сделок', kind: 'count' },
  { key: 'salesSum', label: 'Сумма продаж', kind: 'money' },
  { key: 'shipSum', label: 'Сумма отгрузок', kind: 'money' },
  { key: 'crSale', label: 'Конв. продажа', kind: 'pct' },
  { key: 'crShip', label: 'Конв. отгрузка', kind: 'pct' },
  { key: 'avgCheck', label: 'Средний чек', kind: 'money' },
];

// Палитра линий: спокойные, различимые и на светлой, и на тёмной теме.
const COLORS = ['#2f6fed', '#2f9e44', '#e8590c', '#9c36b5', '#0c8599', '#e03131', '#5f3dc4', '#1098ad', '#f08c00', '#495057', '#c2255c'];
const TEMP_COLOR = '#f59f00';

export type City = 'spb' | 'msk' | 'krd';
const CITY_LABEL: Record<City, string> = { spb: 'СПб', msk: 'Москва', krd: 'Краснодар' };
const CITIES: City[] = ['spb', 'msk', 'krd'];

const TEMP_PREFIX = /^\s*t\s*[+\-−]?\d+\s*(?:\.{2,3}|…|-{1,2})\s*[+\-−]?\d+\s*[,.;:—-]?\s*/i;
const stripTemp = (text: string | null | undefined): string => {
  if (!text) return '';
  const out = text.replace(TEMP_PREFIX, '').trim();
  return out.length >= 3 ? out.charAt(0).toUpperCase() + out.slice(1) : text.trim();
};

function fmtVal(v: number | null | undefined, kind: 'count' | 'money' | 'pct'): string {
  if (v === null || v === undefined) return '—';
  if (kind === 'pct') return `${(v * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  if (kind === 'money') {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
    if (abs >= 1_000) return `${Math.round(v / 1_000).toLocaleString('ru-RU')} тыс ₽`;
    return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  }
  return Math.round(v).toLocaleString('ru-RU');
}
function fmtDelta(cur: number | null, prev: number | null, kind: 'count' | 'money' | 'pct'): string | null {
  if (cur === null || prev === null) return null;
  if (kind === 'pct') {
    const d = (cur - prev) * 100;
    return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.п.`;
  }
  if (prev === 0) return null;
  const d = ((cur - prev) / prev) * 100;
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%`;
}

interface Row {
  i: number;
  label: string;
  weekStart: string;
  month: number;
  temp: number | null;
  cloud: number | null;
  short: string | null;
  comment: string;
  [seriesKey: string]: number | string | null;
}

export function YearWeeklyChart({ data, year, years, onYearChange, initialCity, onClose }: {
  data: YearWeeklyResult;
  year: number;
  years: number[];
  onYearChange: (y: number) => void;
  initialCity: City;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [metric, setMetric] = useState<ChartMetric>('deals');
  // Филиал — ГЛАВНЫЙ переключатель графика (правка владельца 31.08: «график
  // должен принципиально разбиваться по филиалам и температуру показывать того
  // филиала, который выбран. Наносить все 3 филиала на 1 график смысла нет,
  // разные климатические зоны, разные температуры»). Отсюда: линии — только
  // отделы выбранного филиала, температура — его города.
  const [city, setCity] = useState<City>(initialCity);
  const cityEntities = useMemo(() => data.entities.filter(e => e.city === city), [data.entities, city]);
  const [hidden, setHidden] = useState<Set<EntityKey>>(new Set());
  const [showPrev, setShowPrev] = useState(true);
  const [showTemp, setShowTemp] = useState(true);
  // «Усреднить по годам» (правка владельца 31.08): линии строим по среднему
  // текущего и прошлого года той же ISO-недели — сезонность видно без скачков
  // отдельного года. Доступно только когда есть с чем усреднять.
  const [avgYears, setAvgYears] = useState(false);
  const [pinned, setPinned] = useState<number | null>(null);

  const mDef = METRIC_DEFS.find(m => m.key === metric)!;
  const entityById = useMemo(() => new Map(data.entities.map(e => [e.key, e])), [data.entities]);
  const tempCity = city;
  const averaging = avgYears && data.comparable;
  // Выбранные сущности = все отделы филиала минус снятые галкой.
  const selected = useMemo(() => cityEntities.filter(e => !hidden.has(e.key)).map(e => e.key), [cityEntities, hidden]);

  const weatherBy = useMemo(() => {
    const m = new Map<string, { temp: number | null; cloud: number | null; short: string | null; manual: string | null }>();
    for (const w of data.weather) {
      m.set(`${w.city}:${w.weekStart}`, { temp: w.autoTemp, cloud: w.autoCloud, short: w.autoShort, manual: w.manualText });
    }
    return m;
  }, [data.weather]);

  const rows = useMemo((): Row[] => data.weeks.map((w, i) => {
    const wx = weatherBy.get(`${tempCity}:${w.weekStart}`);
    const wxPrev = weatherBy.get(`${tempCity}:${w.prevWeekStart}`);
    const row: Row = {
      i, label: w.label, weekStart: w.weekStart, month: w.month,
      temp: wx?.temp ?? null, cloud: wx?.cloud ?? null, short: wx?.short ?? null,
      comment: stripTemp(wx?.manual),
    };
    // В режиме усреднения температуру тоже усредняем — иначе линия погоды
    // относилась бы к одному году, а столбцы метрик к двум.
    if (averaging) {
      const pair = [wx?.temp, wxPrev?.temp].filter((v): v is number => typeof v === 'number');
      row.temp = pair.length ? pair.reduce((a, b) => a + b, 0) / pair.length : null;
    }
    for (const key of selected) {
      const cur = (w.cur[key] as EntityMetrics | undefined)?.[metric] ?? null;
      const prev = (w.prev[key] as EntityMetrics | undefined)?.[metric] ?? null;
      // raw_* — значения по годам как есть (нужны подсказке и в режиме
      // усреднения); cur_/prev_ — то, что реально рисуется линиями.
      row[`raw_cur_${key}`] = cur;
      row[`raw_prev_${key}`] = prev;
      if (averaging) {
        const pair = [cur, prev].filter((v): v is number => typeof v === 'number');
        row[`cur_${key}`] = pair.length ? pair.reduce((a, b) => a + b, 0) / pair.length : null;
        row[`prev_${key}`] = null;
      } else {
        row[`cur_${key}`] = cur;
        row[`prev_${key}`] = prev;
      }
    }
    return row;
  }), [data.weeks, selected, metric, weatherBy, tempCity, averaging]);

  // Полосы месяцев: подложка через неделю, чтобы глаз видел границы месяцев.
  const monthBands = useMemo(() => {
    const out: { from: number; to: number; month: number }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.month === r.month) last.to = r.i;
      else out.push({ from: r.i, to: r.i, month: r.month });
    }
    return out.filter((_, idx) => idx % 2 === 1);
  }, [rows]);

  const toggleEntity = (key: EntityKey) => setHidden(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Закрепление недели считаем по координате указателя, а не по состоянию
  // recharts: тот отдаёт активную точку только после mousemove (на тапе с
  // телефона его нет), да ещё и строкой. Границы полотна берём у сетки —
  // это ровно область построения, без осей и отступов.
  const pinAtPointer = (clientX: number) => {
    const grid = canvasRef.current?.querySelector('.recharts-cartesian-grid');
    const r = grid?.getBoundingClientRect();
    if (!r || r.width <= 0 || rows.length < 2) return;
    if (clientX < r.left - 8 || clientX > r.right + 8) return;
    const t = (clientX - r.left) / r.width;
    const i = Math.min(rows.length - 1, Math.max(0, Math.round(t * (rows.length - 1))));
    setPinned(prev => (prev === i ? null : i));
  };

  const pinnedRow = pinned !== null ? rows[pinned] : null;
  const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

  const chipCls = (on: boolean) =>
    `tap-target min-h-8 rounded-full border px-3 text-[11px] font-semibold transition-colors ${
      on ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
         : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]">
      {/* Шапка: метрика, пресеты, тумблеры */}
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2 sm:px-5">
        {/* На узком экране заголовок и крестик держим одной строкой, чипы метрик
            переносим ниже: иначе ml-auto уносил крестик на отдельную строку. */}
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">График</h2>
          {/* Год — прямо в графике, чтобы не закрывать его ради переключения
              (правка владельца 31.08: «нельзя выбрать 2025 год отдельно»). */}
          <div className="flex shrink-0 overflow-hidden rounded-lg border border-[var(--color-border)]">
            {years.map(y => (
              <button key={y} type="button" onClick={() => onYearChange(y)}
                className={`tap-target min-h-8 px-2.5 text-[11px] font-semibold ${
                  year === y ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                             : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                {y}
              </button>
            ))}
          </div>
          <div className="hidden flex-wrap gap-1 sm:flex">
            {METRIC_DEFS.map(m => (
              <button key={m.key} type="button" onClick={() => setMetric(m.key)} className={chipCls(metric === m.key)}>
                {m.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} title="Закрыть график"
            className="tap-target ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
            <X size={18} />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1 sm:hidden">
          {METRIC_DEFS.map(m => (
            <button key={m.key} type="button" onClick={() => setMetric(m.key)} className={chipCls(metric === m.key)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* Филиал — главный переключатель: климат у трёх городов разный,
              смешивать их на одном полотне бессмысленно. */}
          <div className="flex shrink-0 overflow-hidden rounded-lg border border-[var(--color-border)]">
            {CITIES.map(c => (
              <button key={c} type="button" onClick={() => { setCity(c); setHidden(new Set()); setPinned(null); }}
                className={`tap-target min-h-8 px-3 text-[11px] font-semibold ${
                  city === c ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                             : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                {CITY_LABEL[c]}
              </button>
            ))}
          </div>
          <span className="mx-1 h-5 w-px bg-[var(--color-border)]" />
          {data.comparable && (
            <button type="button" onClick={() => setAvgYears(v => !v)} className={chipCls(averaging)}
              title={`Линии по среднему значению ${year - 1} и ${year} на той же ISO-неделе`}>
              Усреднить по годам
            </button>
          )}
          {data.comparable && !averaging && (
            <button type="button" onClick={() => setShowPrev(v => !v)} className={chipCls(showPrev)}>
              {year - 1} год пунктиром
            </button>
          )}
          <button type="button" onClick={() => setShowTemp(v => !v)} className={chipCls(showTemp)}>
            <Thermometer size={11} className="mr-1 inline align-[-1px]" />
            Температура ({CITY_LABEL[tempCity]})
          </button>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {averaging
              ? `среднее ${year - 1} и ${year}`
              : data.comparable ? `${year} к ${year - 1}` : `${year}`}
            {metric === 'avgCheck' && ' · ср. чек — по первичным отгрузкам'}
          </span>
        </div>
      </div>

      {/* Сущности */}
      <div className="shrink-0 scroll-x scrollbar-none flex gap-1.5 border-b border-[var(--color-border)] px-3 py-2 sm:px-5">
        {cityEntities.map((e) => {
          const idx = data.entities.findIndex(x => x.key === e.key);
          const on = selected.includes(e.key);
          return (
            <button key={e.key} type="button" onClick={() => toggleEntity(e.key)}
              className={`tap-target min-h-8 shrink-0 rounded-full border px-3 text-[11px] font-semibold whitespace-nowrap transition-colors ${
                on ? 'text-[var(--color-text-inverse)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}
              style={on ? { background: COLORS[idx % COLORS.length], borderColor: COLORS[idx % COLORS.length] } : undefined}>
              {e.label}
            </button>
          );
        })}
      </div>

      {/* Полотно */}
      <div ref={canvasRef} className="min-h-0 flex-1 px-1 py-2 sm:px-4"
        onPointerUp={(e) => pinAtPointer(e.clientX)}>
        {selected.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            Выберите хотя бы одну сущность выше
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: showTemp ? (isMobile ? 6 : 52) : 12, bottom: 4, left: isMobile ? -8 : 8 }}
>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              {/* Подложки месяцев — через один, чтобы видеть границы месяцев */}
              {monthBands.map(b => (
                <ReferenceArea key={b.month} x1={b.from} x2={b.to} fill="var(--color-text-muted)" fillOpacity={0.05} />
              ))}
              <XAxis dataKey="i" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={22}
                tickFormatter={(v: number) => rows[v]?.label ?? ''} />
              <YAxis yAxisId="left" tick={{ fontSize: 10 }} width={isMobile ? 46 : 64}
                tickFormatter={(v: number) => mDef.kind === 'pct'
                  ? `${Math.round(v * 100)}%`
                  : Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}М`
                  : Math.abs(v) >= 1_000 ? `${Math.round(v / 1_000)}т` : String(Math.round(v))} />
              {showTemp && (
                <YAxis yAxisId="temp" orientation="right" tick={{ fontSize: 10, fill: TEMP_COLOR }} width={44}
                  tickFormatter={(v: number) => `${Math.round(v)}°`} />
              )}
              <Tooltip content={<ChartTooltip selected={selected} entityById={entityById} mDef={mDef}
                showPrev={showPrev && data.comparable} showTemp={showTemp} year={year} averaging={averaging} />} />
              {/* На телефоне легенда занимает три строки и наезжает на подписи
                  оси — цвета и так видны на чипах отделов выше. */}
              {!isMobile && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {showTemp && (
                <Line yAxisId="temp" type="monotone" dataKey="temp"
                  name={`Температура, ${CITY_LABEL[tempCity]}${averaging ? ' (среднее)' : ''}`}
                  stroke={TEMP_COLOR} strokeWidth={1.5} strokeDasharray="1 3" dot={false} isAnimationActive={false} connectNulls />
              )}
              {selected.map(key => {
                const idx = data.entities.findIndex(e => e.key === key);
                const color = COLORS[(idx < 0 ? 0 : idx) % COLORS.length];
                return (
                  <Line key={`cur_${key}`} yAxisId="left" type="monotone" dataKey={`cur_${key}`}
                    name={`${entityById.get(key)?.label ?? key}${averaging ? ' (среднее)' : ''}`} stroke={color} strokeWidth={2}
                    dot={!isMobile && rows.length <= 40} isAnimationActive={false} connectNulls />
                );
              })}
              {showPrev && !averaging && data.comparable && selected.map(key => {
                const idx = data.entities.findIndex(e => e.key === key);
                const color = COLORS[(idx < 0 ? 0 : idx) % COLORS.length];
                return (
                  <Line key={`prev_${key}`} yAxisId="left" type="monotone" dataKey={`prev_${key}`}
                    name={`${entityById.get(key)?.label ?? key} · ${year - 1}`} stroke={color}
                    strokeOpacity={0.45} strokeWidth={1.5} strokeDasharray="4 4" dot={false}
                    isAnimationActive={false} connectNulls legendType="none" />
                );
              })}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Закреплённая неделя: полный комментарий + все метрики выбранных сущностей */}
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2 sm:px-5">
        {pinnedRow ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-bold text-[var(--color-text)]">{pinnedRow.label}</span>
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {MONTH_NOM[pinnedRow.month - 1]} · {averaging ? `среднее ${year - 1} и ${year}` : year}
              </span>
              {pinnedRow.short && !averaging && (
                <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: `color-mix(in srgb, ${TEMP_COLOR} 16%, transparent)`, color: TEMP_COLOR }}>
                  {pinnedRow.short} · {CITY_LABEL[tempCity]}
                </span>
              )}
              <button type="button" onClick={() => setPinned(null)}
                className="tap-target ml-auto text-[11px] text-[var(--color-accent)] hover:underline">снять</button>
            </div>
            {pinnedRow.comment ? (
              <p className="flex items-start gap-1.5 text-[12px] leading-snug text-[var(--color-text)]">
                <MessageSquareText size={13} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                {pinnedRow.comment}
              </p>
            ) : (
              <p className="text-[11px] text-[var(--color-text-muted)]">Комментария за эту неделю нет.</p>
            )}
            <div className="scroll-x scrollbar-none flex gap-3 pt-0.5">
              {selected.map(key => {
                const cur = pinnedRow[`cur_${key}`] as number | null;
                const prev = pinnedRow[`raw_prev_${key}`] as number | null;
                const d = averaging || !data.comparable ? null : fmtDelta(pinnedRow[`raw_cur_${key}`] as number | null, prev, mDef.kind);
                return (
                  <span key={key} className="shrink-0 whitespace-nowrap text-[11px] text-[var(--color-text-muted)]">
                    {entityById.get(key)?.label}: <b className="text-[var(--color-text)] tabular-nums">{fmtVal(cur, mDef.kind)}</b>
                    {d && <span className="ml-1 tabular-nums">{d}</span>}
                  </span>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Наведись на неделю, чтобы увидеть цифры и комментарий; клик по графику закрепляет неделю здесь.
          </p>
        )}
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, selected, entityById, mDef, showPrev, showTemp, year, averaging }: {
  active?: boolean;
  payload?: { payload?: Row }[];
  selected: EntityKey[];
  entityById: Map<EntityKey, { label: string; city: string }>;
  mDef: { kind: 'count' | 'money' | 'pct'; label: string };
  showPrev: boolean;
  showTemp: boolean;
  year: number;
  averaging: boolean;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="max-w-[320px] rounded-lg border border-[var(--color-border)] p-2.5 text-[11px]"
      style={{ background: 'var(--color-bg-overlay)', backdropFilter: 'var(--glass-blur)' }}>
      <div className="mb-1 flex items-baseline gap-2">
        <b className="text-[12px] text-[var(--color-text)]">{row.label}</b>
        {showTemp && row.short && !averaging && <span style={{ color: TEMP_COLOR }}>{row.short}</span>}
        {showTemp && averaging && typeof row.temp === 'number' && (
          <span style={{ color: TEMP_COLOR }}>{Math.round(row.temp)}° в среднем</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        {selected.map(key => {
          const plotted = row[`cur_${key}`] as number | null;
          const rawCur = row[`raw_cur_${key}`] as number | null;
          const rawPrev = row[`raw_prev_${key}`] as number | null;
          const d = !averaging && showPrev ? fmtDelta(rawCur, rawPrev, mDef.kind) : null;
          return (
            <div key={key} className="flex items-baseline justify-between gap-3 tabular-nums">
              <span className="text-[var(--color-text-muted)]">{entityById.get(key)?.label}</span>
              <span className="text-[var(--color-text)]">
                {fmtVal(plotted, mDef.kind)}
                {averaging ? (
                  <span className="ml-1 text-[var(--color-text-muted)]">
                    ({year - 1}: {fmtVal(rawPrev, mDef.kind)} · {year}: {fmtVal(rawCur, mDef.kind)})
                  </span>
                ) : (
                  showPrev && <span className="ml-1 text-[var(--color-text-muted)]">/ {fmtVal(rawPrev, mDef.kind)} ({year - 1})</span>
                )}
                {d && <b className="ml-1">{d}</b>}
              </span>
            </div>
          );
        })}
      </div>
      {row.comment && (
        <p className="mt-1.5 border-t border-[var(--color-border)] pt-1.5 leading-snug text-[var(--color-text)] line-clamp-4">
          {row.comment}
        </p>
      )}
    </div>
  );
}
