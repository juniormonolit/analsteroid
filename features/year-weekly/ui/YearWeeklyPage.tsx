'use client';
import { Fragment, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { YearWeeklyChart } from './YearWeeklyChart';
import type { EntityKey, EntityMetrics, NonMoneyPlan, YearWeeklyResult } from '@/features/year-weekly/shared';

// Спец-отчёт «Данные по годам» — зеркало ручного файла владельца (скрин 28.08):
// понедельный «год к году», строки 2025г/2026г/План на каждую неделю + месячные
// ИТОГО, заливка колонок по метрикам (продажи — голубой, отгрузки — зелёный,
// конверсии — жёлтый), «Откл» цветным бейджем, погода городов текстом.
// Таблица широкая — живёт в собственном scroll-x (правило 2 CLAUDE.md),
// первые колонки (год/неделя) — sticky.

type MetricKey = 'deals' | 'salesSum' | 'shipSum' | 'crSale' | 'crShip' | 'avgCheck';
interface MetricDef { key: MetricKey; label: string; kind: 'count' | 'money' | 'pct'; tintC?: string; tintP?: number }
const METRICS: MetricDef[] = [
  { key: 'deals', label: 'Кол-во сделок (перв.)', kind: 'count' },
  { key: 'salesSum', label: 'Сумма продаж', kind: 'money', tintC: '#4aa3e0', tintP: 12 },
  { key: 'shipSum', label: 'Сумма отгрузок', kind: 'money', tintC: '#2f9e44', tintP: 10 },
  { key: 'crSale', label: 'Конв. продажа', kind: 'pct', tintC: '#f5c518', tintP: 16 },
  { key: 'crShip', label: 'Конв. отгрузка', kind: 'pct', tintC: '#e8930c', tintP: 14 },
  { key: 'avgCheck', label: 'Средний чек', kind: 'money' },
];

// ЗАЛИВКА КОЛОНКИ в теле — поверх фона строки, полупрозрачная (так видно
// «зебру» и подсветку ИТОГО).
const tintBody = (m: MetricDef): string =>
  m.tintC ? `color-mix(in srgb, ${m.tintC} ${m.tintP}%, transparent)` : 'transparent';

// ЗАЛИВКА В ШАПКЕ — тот же оттенок, но замешанный в НЕПРОЗРАЧНУЮ подложку.
// «Наш любимый баг с прозрачной шапкой» (владелец 28.08, скрин: сквозь
// закреплённую шапку читались цифры таблицы): --color-bg-surface в этом проекте
// имеет альфу (68%/60%/7.5% по темам), а color-mix(..., transparent) прозрачен
// вообще. Лечение — то же, что в components/ui/Modal.tsx (регресс #2999):
// заведомо плотный --color-bg-overlay (94-96%) + backdrop-filter.
const tintHead = (m: MetricDef): string =>
  m.tintC
    ? `color-mix(in srgb, ${m.tintC} ${m.tintP}%, var(--color-bg-overlay))`
    : 'var(--color-bg-overlay)';

// Колонка-запас в конце таблицы (правка владельца 28.08: «на Краснодар просто
// не наехать, так как таблица заканчивается и скролл дальше не идёт»). Пустая
// колонка шириной в экран продлевает полотно, и последний блок можно подтянуть
// к левому краю, как любой другой. Ширина во vw, а не в px: на узком окне запас
// должен быть меньше, иначе полоса скролла уезжает в пустоту.
const TAIL = 'min-w-[62vw]';

// Живые комментарии из файла владельца почти все начинаются с температуры
// («t +19...+30, жара - июль, рост цен на топливо») — а температура теперь и так
// стоит в свёрнутой строке из метеоданных. Убираем ведущий префикс ПРИ ВЫВОДЕ
// (правка владельца 28.08: «всё равно вижу температуру там, где коммент»);
// сам текст в БД не трогаем — если шаблон не совпал, ничего не потеряется.
const TEMP_PREFIX = /^\s*t\s*[+\-−]?\d+\s*(?:\.{2,3}|…|-{1,2})\s*[+\-−]?\d+\s*[,.;:—-]?\s*/i;
const stripTemp = (text: string | null | undefined): string => {
  if (!text) return '';
  const out = text.replace(TEMP_PREFIX, '').trim();
  // Если после срезки не осталось ничего осмысленного — показываем как было.
  return out.length >= 3 ? out.charAt(0).toUpperCase() + out.slice(1) : text.trim();
};

// Непрозрачная подложка закреплённых ячеек (шапка и колонки года/недели).
const OPAQUE = 'bg-[var(--color-bg-overlay)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)]';
// Подложка закреплённых ячеек в строке ИТОГО: та же серая заливка, что у всей
// строки (правка владельца 28.08: «в фиксированных столбцах окраска должна быть
// та же, что и у всей вертикали, то есть у ИТОГО тоже серенькая»). Сразу
// НЕПРОЗРАЧНАЯ — иначе сквозь закреплённые колонки при горизонтальном скролле
// просвечивали бы цифры (тот же класс бага, что «прозрачная шапка»):
// --color-bg-hover в теме mono сам альфа-цвет, поэтому мешаем его в overlay.
const OPAQUE_TOTAL = '[-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)]';
const TOTAL_STICKY_BG = 'color-mix(in srgb, var(--color-bg-hover) 65%, var(--color-bg-overlay))';
// СПБ/МСК ИТОГО в файле — только продажи и отгрузки.
const TOTAL_METRICS = METRICS.filter(m => m.key === 'salesSum' || m.key === 'shipSum');

// Жирная вертикальная граница на стыке смысловых блоков — сущностей (правка
// владельца 28.08). Ставится на ПОСЛЕДНЮЮ ячейку блока во ВСЕХ рядах шапки и
// тела, иначе линия рвётся построчно. Цвет — border-strong: на широкой таблице
// в 7800px обычный hairline между блоками не читался.
const BLOCK_EDGE = 'border-r-[3px] border-r-[var(--color-border-strong,var(--color-text-muted))]';

// Плавный горизонтальный скролл к блоку города (правка владельца 28.08:
// «якорные ссылки на горизонтальный скролл по городам… автоскролл должен быть
// плавным как у Эпл»). Нативный scrollTo({behavior:'smooth'}) рисует СВОЮ
// кривую браузера — здесь взята эталонная кривая проекта из
// app/styles/tokens/effects.css: --anim-duration 280ms,
// --anim-ease cubic-bezier(0.32,0.72,0,1) (тот самый iOS-деселерейт: быстрый
// старт, мягкое торможение). JS не читает CSS-переменные, поэтому значения
// продублированы — при изменении токена поправить и здесь.
const EASE = [0.32, 0.72, 0, 1] as const;
const ANIM_MS = 280;

/** cubic-bezier(x1,y1,x2,y2) в точке t по X — методом Ньютона, как в браузере. */
function cubicBezier(t: number): number {
  const [, y1, , y2] = EASE;
  const [x1, , x2] = [EASE[0], 0, EASE[2]];
  const cx = (u: number) => 3 * x1 * (1 - u) ** 2 * u + 3 * x2 * (1 - u) * u ** 2 + u ** 3;
  const cy = (u: number) => 3 * y1 * (1 - u) ** 2 * u + 3 * y2 * (1 - u) * u ** 2 + u ** 3;
  let u = t;
  for (let i = 0; i < 6; i++) {
    const err = cx(u) - t;
    if (Math.abs(err) < 1e-4) break;
    const d = 3 * x1 * (1 - u) * (1 - 3 * u) + 3 * x2 * u * (2 - 3 * u) + 3 * u ** 2;
    if (Math.abs(d) < 1e-6) break;
    u -= err / d;
  }
  return cy(Math.min(1, Math.max(0, u)));
}

function animateScrollLeft(el: HTMLElement, to: number): void {
  const from = el.scrollLeft;
  const dist = to - from;
  if (Math.abs(dist) < 2) return;
  // Длинный прыжок по полотну в 7800px за 280мс читается как рывок, поэтому
  // длительность растёт с расстоянием, но не дольше 600мс — иначе ожидание.
  const dur = Math.min(600, Math.max(ANIM_MS, Math.abs(dist) / 4));
  // prefers-reduced-motion — переносим мгновенно (правило доступности проекта).
  // document.hidden — тоже мгновенно: в скрытой вкладке requestAnimationFrame не
  // вызывается вообще, и без этой ветки клик по якорю не делал бы НИЧЕГО
  // (поймано на превью 28.08: панель браузера была скрыта, rAF не срабатывал).
  if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.scrollLeft = to;
    return;
  }
  const t0 = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    el.scrollLeft = from + dist * cubicBezier(p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const CITY_LABEL: Record<string, string> = { spb: 'Погода СПБ', msk: 'Погода МСК', krd: 'Погода КРД' };

function fmt(v: number | null | undefined, kind: 'count' | 'money' | 'pct'): string {
  if (v === null || v === undefined) return '—';
  if (kind === 'pct') return `${(v * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  if (kind === 'money') return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  return Math.round(v).toLocaleString('ru-RU');
}

function Dev({ cur, prev, kind }: { cur: number | null | undefined; prev: number | null | undefined; kind: 'count' | 'money' | 'pct' }) {
  if (cur == null || prev == null) return <span className="text-[var(--color-text-muted)]">—</span>;
  // Конверсии — разница в п.п. (проценты от процентов сбивают с толку),
  // деньги/количества — относительный %.
  if (kind === 'pct') {
    const d = (cur - prev) * 100;
    if (Math.abs(d) < 0.05) return <span className="text-[var(--color-text-muted)]">0</span>;
    const pos = d > 0;
    return <span className={`rounded px-1 font-semibold ${pos ? 'bg-[var(--color-positive,#2f9e44)]/15 text-[var(--color-positive,#2f9e44)]' : 'bg-[var(--color-negative,#e03131)]/15 text-[var(--color-negative,#e03131)]'}`}>
      {pos ? '+' : '−'}{Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}
    </span>;
  }
  if (prev === 0) return <span className="text-[var(--color-text-muted)]">—</span>;
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return <span className="text-[var(--color-text-muted)]">0%</span>;
  const pos = d > 0;
  return <span className={`rounded px-1 font-semibold ${pos ? 'bg-[var(--color-positive,#2f9e44)]/15 text-[var(--color-positive,#2f9e44)]' : 'bg-[var(--color-negative,#e03131)]/15 text-[var(--color-negative,#e03131)]'}`}>
    {pos ? '+' : '−'}{Math.abs(d * 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%
  </span>;
}

interface TriRow {
  kind: 'prev' | 'cur' | 'plan';
  yearLabel: string;
  weekLabel: string;
  monthBoundary?: boolean;   // серая полоса-разделитель ПЕРЕД блоком
  isTotal?: boolean;         // месячные ИТОГО — фон
  weekStart?: string;        // у cur-строки — ключ погоды
  get: (e: EntityKey) => EntityMetrics | null;
  getPlan?: (e: EntityKey) => { sales: number | null; ship: number | null; other: NonMoneyPlan };
}

export function YearWeeklyPage({ isSuperadmin }: { isSuperadmin: boolean }) {
  const nowYear = new Date().getFullYear();
  const [year, setYear] = useState(nowYear);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<YearWeeklyResult>({
    queryKey: ['year-weekly', year],
    queryFn: async () => {
      const res = await fetch(`/api/year-weekly?year=${year}`);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const [editWeather, setEditWeather] = useState<{ city: string; weekStart: string; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cornerRef = useRef<HTMLTableCellElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [activeCity, setActiveCity] = useState<'spb' | 'msk' | 'krd'>('spb');

  // Ручной скролл тоже переключает активную кнопку: иначе подсветка врёт
  // («СПб» горит, когда на экране Краснодар).
  const onScroll = () => {
    const box = scrollRef.current;
    const corner = cornerRef.current;
    const table = tableRef.current;
    if (!box || !corner || !table) return;
    // Та же система координат, что в jumpToCity: смещения от левого края таблицы.
    const x = box.scrollLeft + corner.offsetWidth + 8;
    let cur: 'spb' | 'msk' | 'krd' = 'spb';
    for (const c of ['spb', 'msk', 'krd'] as const) {
      const th = box.querySelector<HTMLElement>(`[data-city-anchor="${c}"]`);
      if (th && th.offsetLeft - table.offsetLeft <= x) cur = c;
    }
    setActiveCity(prev => (prev === cur ? prev : cur));
  };

  // Якорь города = левый край его ПЕРВОГО блока минус ширина закреплённых
  // колонок (они перекрывают контент, и без вычета блок уезжает под них).
  const jumpToCity = (city: 'spb' | 'msk' | 'krd') => {
    const box = scrollRef.current;
    const corner = cornerRef.current;
    const table = tableRef.current;
    const th = box?.querySelector<HTMLElement>(`[data-city-anchor="${city}"]`);
    if (!box || !th || !corner || !table) return;
    // Опора — САМА ТАБЛИЦА, а не угловая ячейка: угловая ячейка sticky, и её
    // offsetLeft растёт вместе со scrollLeft. Из-за этого первый прыжок работал
    // (скролл был в нуле), а следующий считался от съехавшей точки — «на
    // Краснодар просто не наехать» (скрин владельца 28.08). offsetLeft таблицы
    // от скролла не зависит; corner.offsetWidth — ширина обеих закреплённых
    // колонок (colSpan=2), её вычитаем, чтобы блок встал ПРАВЕЕ них.
    animateScrollLeft(box, Math.max(0, th.offsetLeft - table.offsetLeft - corner.offsetWidth));
    setActiveCity(city);
  };

  const weatherBy = useMemo(() => {
    const m = new Map<string, { manual: string | null; auto: string | null; short: string | null }>();
    for (const w of data?.weather ?? []) {
      m.set(`${w.city}:${w.weekStart}`, { manual: w.manualText, auto: w.autoSummary, short: w.autoShort });
    }
    return m;
  }, [data]);
  // Развёрнутые погодные ячейки (правка владельца 28.08: «свёрнутыми в 1
  // строчку с возможностью развернуть и прочитать»). Свёрнутый вид — короткая
  // метеосводка «+5, пасмурно, дожди», она влезает в строку и одинаково узкая
  // у всех недель, поэтому строки таблицы не пляшут по высоте.
  const [chartOpen, setChartOpen] = useState(false);
  const [openWeather, setOpenWeather] = useState<Set<string>>(new Set());
  const toggleWeather = (k: string) => setOpenWeather(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // Строки: недели месяца → ИТОГО месяца → следующая тройка.
  const rows = useMemo((): TriRow[] => {
    if (!data) return [];
    // У самого первого года данных (2025) прошлого года нет вовсе — строки
    // «2024г» были бы нулями, а «Откл» — мусором (правка владельца 31.08:
    // «нельзя выбрать 2025 год отдельно»).
    const cmp = data.comparable;
    const out: TriRow[] = [];
    let lastMonth = 0;
    for (const w of data.weeks) {
      const boundary = w.month !== lastMonth;
      if (w.month !== lastMonth && lastMonth !== 0) {
        const mb = data.months.find(m => m.month === lastMonth);
        if (mb) {
          if (cmp) out.push({ kind: 'prev', yearLabel: `${year - 1}г`, weekLabel: `${mb.label} ${year - 1}`, isTotal: true, get: e => mb.prev[e] });
          out.push({ kind: 'cur', yearLabel: `${year}г`, weekLabel: `${mb.label} ${year}`, isTotal: true, get: e => mb.cur[e] });
          out.push({ kind: 'plan', yearLabel: 'План', weekLabel: 'ИТОГО план', isTotal: true, get: () => null, getPlan: e => ({ sales: mb.planSales[e], ship: mb.planShip[e], other: mb.planOther[e] }) });
        }
      }
      lastMonth = w.month;
      if (cmp) out.push({ kind: 'prev', yearLabel: `${year - 1}г`, weekLabel: w.prevLabel, monthBoundary: boundary, get: e => w.prev[e] });
      out.push({ kind: 'cur', yearLabel: `${year}г`, weekLabel: w.label, weekStart: w.weekStart, monthBoundary: cmp ? undefined : boundary, get: e => w.cur[e] });
      out.push({ kind: 'plan', yearLabel: '', weekLabel: 'План', get: () => null, getPlan: e => ({ sales: w.planSales[e], ship: w.planShip[e], other: w.planOther[e] }) });
    }
    // хвостовой ИТОГО текущего месяца
    const mb = data.months.find(m => m.month === lastMonth);
    if (mb) {
      if (cmp) out.push({ kind: 'prev', yearLabel: `${year - 1}г`, weekLabel: `${mb.label} ${year - 1}`, isTotal: true, monthBoundary: true, get: e => mb.prev[e] });
      out.push({ kind: 'cur', yearLabel: `${year}г`, weekLabel: `${mb.label} ${year}`, isTotal: true, get: e => mb.cur[e] });
      out.push({ kind: 'plan', yearLabel: 'План', weekLabel: 'ИТОГО план', isTotal: true, get: () => null, getPlan: e => ({ sales: mb.planSales[e], ship: mb.planShip[e], other: mb.planOther[e] }) });
    }
    return out;
  }, [data, year]);

  // Пары строк для «Откл»: cur сравнивается с prev той же тройки.
  const prevOf = (idx: number): TriRow | null => (rows[idx]?.kind === 'cur' && rows[idx - 1]?.kind === 'prev' ? rows[idx - 1] : null);

  const entities = data?.entities ?? [];
  const stickyBg = OPAQUE;
  // Закрепление шапки: три ряда прилипают друг под другом. Высоты заданы явно
  // (h-*), иначе top второго и третьего ряда пришлось бы угадывать — при
  // расхождении ряды наезжают друг на друга при скролле.
  const HEAD_H = [28, 26, 18];
  const headCell = `sticky ${stickyBg} z-20`;
  const headTop = (i: number) => ({ top: HEAD_H.slice(0, i).reduce((a, b) => a + b, 0) });

  return (
    // Высота таблицы — ОСТАТОК по флексу, а не «экран минус N пикселей»
    // (правка владельца 28.08: «че за отступ внизу появился?»). Прежний
    // max-h-[calc(100dvh-190px)] был догадкой о высоте шапки: реальная шапка
    // ниже, и снизу оставалась пустая полоса. Флекс считает сам и не врёт при
    // любой длине подписей и переносе кнопок на вторую строку.
    <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-[var(--color-text)]">Данные по годам</h1>
          <div className="flex overflow-hidden rounded-lg border border-[var(--color-border)]">
            {[nowYear - 1, nowYear].map(y => (
              <button key={y} type="button" onClick={() => setYear(y)}
                className={`tap-target min-h-8 px-3 text-xs font-semibold ${year === y ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                {y}
              </button>
            ))}
          </div>
          {/* Якорные ссылки по городам (правка владельца 28.08) — полотно
              шириной ~7800px, доскроллить до Краснодара мышью утомительно. */}
          <div className="flex items-center gap-1">
            {([['spb', 'СПб'], ['msk', 'Москва'], ['krd', 'Краснодар']] as const).map(([c, label]) => (
              <button key={c} type="button" onClick={() => jumpToCity(c)}
                title={`Перейти к блокам «${label}»`}
                className={`tap-target min-h-8 rounded-full border px-3 text-xs font-semibold transition-colors ${
                  activeCity === c
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                {label}
              </button>
            ))}
          </div>
          {/* График (задача владельца 28.08) — тот же payload, другой взгляд:
              данные для него уже загружены таблицей, запрос не повторяется.
              Правка 31.08: обычная синяя кнопка у правого края. */}
          <button type="button" onClick={() => setChartOpen(true)} disabled={!data}
            title="Интерактивный график: метрики по неделям, филиалы, температура, комментарии"
            className="tap-target ml-auto min-h-9 flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-xs font-semibold text-[var(--color-text-inverse)] transition-opacity hover:opacity-90 disabled:opacity-40">
            <BarChart3 size={14} /> График
          </button>
          {/* Подсказка — всегда отдельной строкой (basis-full), иначе она
              делила первую строку с кнопкой и «правый край» получался разным
              при разной длине текста. */}
          <span className="basis-full text-xs text-[var(--color-text-muted)]">
            {data?.comparable === false
              ? `${year}-й — первый год данных, сравнивать не с чем`
              : `неделя ${year}-го против той же ISO-недели ${year - 1}-го`}
            {' · '}план = месяц / 4 · сделки и конверсии — первичные · ср. чек — по первичным отгрузкам
            {' · '}погода: свёрнуто — метеоданные (Open-Meteo), развёрнуто — комментарий ответственного
          </span>
        </div>

        {error ? <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось построить отчёт.</div>
        : isLoading || !data ? <div className="text-sm text-[var(--color-text-muted)]">Считаем год…</div>
        : (
          // Контейнер таблицы — скроллер по ОБЕИМ осям с ограниченной высотой:
          // без этого sticky-шапке прилипать не к чему (у .scroll-x высота не
          // ограничена, вертикально он не скроллится, и sticky top мёртв).
          // Правило 2 CLAUDE.md соблюдено: горизонтальный скролл остаётся внутри
          // своего контейнера, страница вбок не едет.
          <div ref={scrollRef} onScroll={onScroll} className="scroll-x min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <table ref={tableRef} className="border-separate border-spacing-0 text-[12px] leading-tight tabular-nums">
              <thead>
                {/* ряд 1: сущности */}
                <tr style={{ height: HEAD_H[0] }}>
                  <th ref={cornerRef} style={headTop(0)} className={`sticky left-0 z-40 ${stickyBg} border-b border-[var(--color-border)] ${BLOCK_EDGE} px-2 py-1`} colSpan={2} />
                  {entities.map((e, ei) => {
                    const ms = e.total ? TOTAL_METRICS : METRICS;
                    const weatherCol = e.total || e.key === 'krd' ? 1 : 0;
                    // Якорь ставим на ПЕРВЫЙ блок города (первое вхождение).
                    const firstOfCity = entities.findIndex(x => x.city === e.city) === ei;
                    return (
                      <th key={e.key} colSpan={ms.length * 2 + weatherCol} style={headTop(0)}
                        data-city-anchor={firstOfCity ? e.city : undefined}
                        className={`${headCell} ${OPAQUE} border-b border-[var(--color-border)] ${BLOCK_EDGE} px-2 py-1.5 text-center font-bold text-[var(--color-text)] whitespace-nowrap`}>
                        {e.label}
                      </th>
                    );
                  })}
                  <th style={headTop(0)} className={`${headCell} ${OPAQUE} ${TAIL} border-b border-[var(--color-border)]`} />
                </tr>
                {/* ряд 2: метрики */}
                <tr style={{ height: HEAD_H[1] }}>
                  <th style={headTop(1)} className={`sticky left-0 z-40 ${stickyBg} border-b border-[var(--color-border)] ${BLOCK_EDGE}`} colSpan={2} />
                  {entities.map(e => {
                    const ms = e.total ? TOTAL_METRICS : METRICS;
                    return (
                      <Fragment key={e.key}>
                        {(e.total || e.key === 'krd') && (
                          <th key={`${e.key}-w`} rowSpan={2} style={headTop(1)} className={`${headCell} ${OPAQUE} border-b border-r border-[var(--color-border)] px-2 py-1 align-bottom text-[11px] font-semibold text-[var(--color-text-muted)] min-w-[180px]`}>
                            {CITY_LABEL[e.city]}
                          </th>
                        )}
                        {ms.map((m, mi) => (
                          <th key={`${e.key}-${m.key}`} colSpan={2} style={{ background: tintHead(m), ...headTop(1) }}
                            className={`sticky z-20 [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-r border-[var(--color-border)] ${mi === ms.length - 1 ? BLOCK_EDGE : ''} px-2 py-1 text-center font-semibold text-[var(--color-text)] whitespace-nowrap`}>
                            {m.label}
                          </th>
                        ))}
                      </Fragment>
                    );
                  })}
                  <th rowSpan={2} style={headTop(1)} className={`${headCell} ${OPAQUE} ${TAIL} border-b border-[var(--color-border)]`} />
                </tr>
                {/* ряд 3: Факт/Откл */}
                <tr style={{ height: HEAD_H[2] }}>
                  <th style={headTop(2)} className={`sticky left-0 z-40 ${stickyBg} border-b-2 border-[var(--color-border)] ${BLOCK_EDGE}`} colSpan={2} />
                  {entities.flatMap(e => {
                    const ms = e.total ? TOTAL_METRICS : METRICS;
                    return ms.flatMap((m, mi) => [
                      <th key={`${e.key}-${m.key}-f`} style={{ background: tintHead(m), ...headTop(2) }} className="sticky z-20 [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b-2 border-[var(--color-border)] px-2 py-0.5 text-right text-[10px] font-medium text-[var(--color-text-muted)]">Факт</th>,
                      <th key={`${e.key}-${m.key}-d`} style={{ background: tintHead(m), ...headTop(2) }} className={`sticky z-20 [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b-2 border-r border-[var(--color-border)] ${mi === ms.length - 1 ? BLOCK_EDGE : ''} px-1 py-0.5 text-center text-[10px] font-medium text-[var(--color-text-muted)]`}>Откл</th>,
                    ]);
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const prevRow = prevOf(idx);
                  const rowBg = r.isTotal ? 'bg-[var(--color-bg-hover)] font-semibold' : '';
                  const boundary = r.monthBoundary ? 'border-t-[6px] border-t-[var(--color-border)]' : '';
                  return (
                    // report-row (globals.css) — та же подсветка строки при
                    // наведении, что в обычных отчётах: фон всей строки + акцентная
                    // полоска слева, !important поверх фонов ячеек (правка владельца
                    // 31.08: «хочу, чтобы при наведении строка подсвечивалась как в
                    // обычных отчётах»).
                    <tr key={idx} className={`report-row ${rowBg}`}>
                      <td style={r.isTotal ? { background: TOTAL_STICKY_BG } : undefined}
                        className={`sticky left-0 z-20 w-[52px] min-w-[52px] ${r.isTotal ? OPAQUE_TOTAL : stickyBg} ${boundary} whitespace-nowrap border-b border-r border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] ${r.isTotal ? 'font-semibold' : ''}`}>{r.yearLabel}</td>
                      <td style={r.isTotal ? { background: TOTAL_STICKY_BG } : undefined}
                        className={`sticky left-[52px] z-20 ${r.isTotal ? OPAQUE_TOTAL : stickyBg} ${boundary} whitespace-nowrap border-b border-[var(--color-border)] ${BLOCK_EDGE} px-2 py-1 ${r.kind === 'cur' ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>{r.weekLabel}</td>
                      {entities.flatMap(e => {
                        const ms = e.total ? TOTAL_METRICS : METRICS;
                        const cells: React.ReactNode[] = [];
                        if (e.total || e.key === 'krd') {
                          if (r.kind === 'cur' && r.weekStart) {
                            const wk = `${e.city}:${r.weekStart}`;
                            const w = weatherBy.get(wk);
                            const opened = openWeather.has(wk);
                            const hasText = !!w?.manual;
                            cells.push(
                              <td key={`${e.key}-w`} className={`${boundary} border-b border-r border-[var(--color-border)] px-2 py-1 align-top w-[200px] max-w-[200px]`}>
                                <div className="flex items-start gap-1">
                                  <button type="button"
                                    onClick={() => hasText && toggleWeather(wk)}
                                    title={hasText ? (opened ? 'Свернуть' : 'Развернуть комментарий') : 'Комментария за эту неделю нет'}
                                    className={`min-w-0 flex-1 text-left ${hasText ? 'cursor-pointer' : 'cursor-default'}`}>
                                    <span className="flex items-center gap-1">
                                      {hasText && (opened
                                        ? <ChevronDown size={11} className="shrink-0 text-[var(--color-accent)]" />
                                        : <ChevronRight size={11} className="shrink-0 text-[var(--color-accent)]" />)}
                                      {/* Свёрнуто — короткая метеосводка в ОДНУ строку. */}
                                      <span className={`truncate text-[11px] ${hasText ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>
                                        {w?.short ?? w?.auto ?? '—'}
                                      </span>
                                    </span>
                                    {/* Развёрнуто — ТОЛЬКО живой комментарий человека, без
                                        метео-приписок (правка владельца 28.08: «не надо
                                        там в комменте отсебятины по температуре и
                                        осадкам»). Цифры метеоданных живут в свёрнутой
                                        строке, дублировать их незачем. */}
                                    {opened && (
                                      <span className="mt-1 block whitespace-pre-wrap text-[11px] leading-snug text-[var(--color-text)]">
                                        {stripTemp(w?.manual)}
                                      </span>
                                    )}
                                  </button>
                                  {isSuperadmin && (
                                    <button type="button" title="Поправить текст погоды"
                                      onClick={() => setEditWeather({ city: e.city, weekStart: r.weekStart!, text: w?.manual ?? '' })}
                                      className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">
                                      <Pencil size={11} />
                                    </button>
                                  )}
                                </div>
                              </td>,
                            );
                          } else {
                            cells.push(<td key={`${e.key}-w`} className={`${boundary} border-b border-r border-[var(--color-border)]`} />);
                          }
                        }
                        for (const m of ms) {
                          let fact: string;
                          if (r.kind === 'plan') {
                            const p = r.getPlan!(e.key);
                            // Деньги — из manager_plans, остальное — из
                            // year_weekly_plans (миграция 166, файл владельца).
                            const other = p.other ?? { deals: null, crSale: null, crShip: null, avgCheck: null };
                            fact = m.key === 'salesSum' ? fmt(p.sales, 'money')
                              : m.key === 'shipSum' ? fmt(p.ship, 'money')
                              : m.key === 'deals' ? fmt(other.deals, 'count')
                              : m.key === 'crSale' ? fmt(other.crSale, 'pct')
                              : m.key === 'crShip' ? fmt(other.crShip, 'pct')
                              : m.key === 'avgCheck' ? fmt(other.avgCheck, 'money')
                              : '—';
                          } else {
                            const v = r.get(e.key);
                            fact = fmt(v?.[m.key] ?? null, m.kind);
                          }
                          cells.push(
                            <td key={`${e.key}-${m.key}-f`} style={{ background: r.isTotal ? undefined : tintBody(m) }}
                              className={`${boundary} whitespace-nowrap border-b border-[var(--color-border)] px-2 py-1 text-right`}>
                              {fact}
                            </td>,
                          );
                          const lastOfBlock = m.key === ms[ms.length - 1].key;
                          cells.push(
                            <td key={`${e.key}-${m.key}-d`} style={{ background: r.isTotal ? undefined : tintBody(m) }}
                              className={`${boundary} whitespace-nowrap border-b border-r border-[var(--color-border)] ${lastOfBlock ? BLOCK_EDGE : ''} px-1 py-1 text-center text-[11px]`}>
                              {r.kind === 'cur' && prevRow
                                ? <Dev cur={r.get(e.key)?.[m.key] ?? null} prev={prevRow.get(e.key)?.[m.key] ?? null} kind={m.kind} />
                                : null}
                            </td>,
                          );
                        }
                        return cells;
                      })}
                      <td className={`${boundary} ${TAIL} border-b border-[var(--color-border)]`} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {chartOpen && data && (
        <YearWeeklyChart
          data={data}
          year={year}
          years={[nowYear - 1, nowYear]}
          onYearChange={setYear}
          initialCity={activeCity}
          onClose={() => setChartOpen(false)}
        />
      )}

      {editWeather && (
        <Modal open onOpenChange={o => { if (!o) setEditWeather(null); }} title="Погода за неделю" desktopWidth="sm:max-w-md">
          <div className="flex flex-col gap-3">
            <textarea value={editWeather.text} onChange={ev => setEditWeather({ ...editWeather, text: ev.target.value })}
              rows={4} maxLength={2000}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-sm" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditWeather(null)}
                className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
              <button type="button"
                onClick={async () => {
                  await fetch('/api/year-weekly/weather', {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ city: editWeather.city, weekStart: editWeather.weekStart, text: editWeather.text }),
                  });
                  setEditWeather(null);
                  void qc.invalidateQueries({ queryKey: ['year-weekly'] });
                }}
                className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-xs font-semibold text-[var(--color-text-inverse)]">Сохранить</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
