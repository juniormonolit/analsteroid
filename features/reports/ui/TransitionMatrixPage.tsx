'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Filter, Search, UserRound, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { DepartmentPicker, PeriodRangeControls } from './FilterBar';
import { applyPreset, calendarComparisonForPreset, type DateRange } from '@/lib/period';
import type { DealScope, ClientType } from '@/lib/metrics/types';
import type { MatrixCell } from '@/features/reports/engine/productMatrix';
import { TransitionDrillModal } from './TransitionDrillModal';

// «Матрица переходов» (задача владельца 10.09): та же квадратная матрица
// «отгружено X → следующим отгружено Y», что «Товарная матрица», но ФАКТ в срезе
// стандартных фильтров отчёта — период, отделы, пилюли перв./повт. и ЧЛ/ЮЛ — плюс
// пикер менеджера с поиском. Цель владельца: «доля продажи кровли после газобетона
// в разрезе периода, отдела, менеджера». Все фильтры режут ЗАКРЫВАЮЩУЮ сделку пары
// (кто продал «следующее»); предыдущая покупка — из всей истории клиента.
// Ячейка: доля переходов из строки + число переходов; строка суммируется в 100 %.
// Дефолтный период — текущий месяц (в отличие от «всё время» у вероятностной
// матрицы): здесь смысл именно в срезе.

interface MatrixResponse {
  categories: string[];
  cells: MatrixCell[];
  rowTotals: Record<string, number>;
  shipments: Record<string, number>;
  total: number;
  shipmentsTotal: number;
}
interface Person { id: string; name: string; department: string | null; branch: string | null }

async function fetchMatrix(body: unknown): Promise<MatrixResponse> {
  const res = await fetch('/api/reports/product-matrix', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(b?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function heatBg(pct: number): string {
  const t = Math.min(pct / 60, 1);
  return `color-mix(in srgb, var(--color-accent) ${Math.round(t * 55)}%, transparent)`;
}

// ── Сортировка матрицы (правка владельца 11.09) ──────────────────────────────
// Клик по заголовку КОЛОНКИ сортирует СТРОКИ по её значениям (сверху вниз от
// большего), клик по названию СТРОКИ — КОЛОНКИ по её значениям (слева направо от
// большего). Третий клик возвращает дефолтный порядок (по объёму отгрузок).
type SortState =
  | { kind: 'rows'; key: string; dir: 'desc' | 'asc' }
  | { kind: 'cols'; key: string; dir: 'desc' | 'asc' }
  | null;

function nextSort(cur: SortState, kind: 'rows' | 'cols', key: string): SortState {
  if (cur && cur.kind === kind && cur.key === key) {
    return cur.dir === 'desc' ? { kind, key, dir: 'asc' } : null;
  }
  return { kind, key, dir: 'desc' };
}

/** Куда двинулся показатель. «Стагнация» — сдвиг доли меньше 1 п.п.
 *  (разница в пределах шума при типичных базах матрицы). */
type Delta = 'up' | 'down' | 'flat' | 'none';
function deltaOf(pct: number, prevPct: number, hasPrevBase: boolean): Delta {
  if (!hasPrevBase) return 'none';
  const d = pct - prevPct;
  if (Math.abs(d) < 1) return 'flat';
  return d > 0 ? 'up' : 'down';
}
const DELTA_CLS: Record<Delta, string> = {
  up: 'text-[var(--color-positive)]',
  down: 'text-[var(--color-negative)]',
  flat: 'text-[var(--color-text-muted)]',
  none: 'text-[var(--color-text)]',
};
const pctStr = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)}%`;

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex rounded-lg border border-[var(--color-border)] overflow-hidden shrink-0">
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`min-h-11 sm:min-h-0 sm:py-1.5 px-3 text-sm transition-colors ${
            value === o.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)] font-medium' : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Пикер менеджера с поиском по имени — список уже обрезан сервером до среза сессии. */
function ManagerPicker({ value, onChange }: { value: Person | null; onChange: (p: Person | null) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { data } = useQuery<{ people: Person[] }>({
    queryKey: ['profile-people'],
    queryFn: async () => {
      const res = await fetch('/api/profile/people');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const people = useMemo(() => {
    const list = data?.people ?? [];
    const needle = q.trim().toLowerCase();
    return (needle ? list.filter(p => `${p.name} ${p.department ?? ''}`.toLowerCase().includes(needle)) : list).slice(0, 200);
  }, [data, q]);
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="w-[320px] max-w-[calc(100vw-16px)]"
        trigger={
          <button type="button" className="min-h-11 sm:min-h-0 sm:py-1.5 px-3 flex items-center gap-1.5 border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors max-w-[260px]">
            <UserRound size={14} className="shrink-0" />
            <span className="truncate">{value ? value.name : 'Все менеджеры'}</span>
          </button>
        }
      >
        <div className="flex flex-col">
          <label className="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
            <Search size={14} className="text-[var(--color-text-muted)] shrink-0" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Поиск по имени или отделу"
              autoFocus
              className="min-h-11 flex-1 min-w-0 bg-transparent text-[16px] sm:text-sm outline-none"
            />
          </label>
          <div className="max-h-[60vh] overflow-y-auto p-1">
            <button type="button" onClick={() => { onChange(null); setOpen(false); }}
              className="min-h-11 w-full rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
              Все менеджеры среза
            </button>
            {people.map(p => (
              <button key={p.id} type="button" onClick={() => { onChange(p); setOpen(false); }}
                className={`min-h-11 w-full rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)] ${value?.id === p.id ? 'font-medium text-[var(--color-accent)]' : ''}`}>
                <span className="block truncate">{p.name}</span>
                {p.department && <span className="block text-[11px] text-[var(--color-text-muted)] truncate">{p.department}</span>}
              </button>
            ))}
            {people.length === 0 && <div className="px-2 py-3 text-center text-xs text-[var(--color-text-muted)]">Никого не нашлось</div>}
          </div>
        </div>
      </Popover>
      {value && (
        <button type="button" onClick={() => onChange(null)} aria-label="Сбросить менеджера"
          className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-negative)]">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function TransitionMatrixPage() {
  // Дефолт периода — «Этот год» (правка владельца 11.09), а не общий по
  // приложению defaultPeriod() «с 1-го числа по вчера»: матрица переходов живёт
  // на длинном горизонте — в первые дни месяца пар «отгрузка → следующая» почти
  // нет и матрица открывалась пустой. Тот же диапазон, что кнопка пресета «Этот
  // год», — формула не дублируется (applyPreset). Замер 11.09 на боевых данных:
  // матрица 0,7 с, дрилл 0,6 с на годовом окне — держит дефолт без кэша.
  const [period, setPeriod] = useState<DateRange>(() => applyPreset('this_year'));
  // Сравнение в этом отчёте не показывается (showComparison={false}) и в расчёте
  // не участвует, но держим его осмысленным — прошлый год целиком.
  const [comparison, setComparison] = useState<DateRange>(() => calendarComparisonForPreset('this_year'));
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [dealScope, setDealScope] = useState<DealScope>('all');
  const [clientType, setClientType] = useState<ClientType>('all');
  const [manager, setManager] = useState<Person | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // категории; пусто = все
  // Открытая ячейка → дрилл «кто продаёт связку + цепочки сделок» (правка 10.09).
  const [drill, setDrill] = useState<{ from: string; to: string } | null>(null);
  // Режим сравнения периодов (правка владельца 11.09) — по умолчанию выключен;
  // включённый добавляет второй запрос за период сравнения и делит ячейку по
  // диагонали. Пикер периода сравнения — тот же, что в основных отчётах.
  const [withComparison, setWithComparison] = useState(false);
  const [sort, setSort] = useState<SortState>(null);

  const body = useMemo(() => ({
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    departmentIds,
    managerIds: manager ? [manager.id] : [],
    dealScope,
    clientType,
    // Категории — по ВСЕМ позициям заказа (правка владельца 10.09): заказ
    // «утеплитель + ОСБ» после газобетона — это два перехода, а не один.
    mode: 'positions' as const,
    // Период и фильтры режут ИСХОДНУЮ отгрузку (правка владельца 10.09): «было
    // 120 отгрузок газобетона → 28 повторов → 23 %» — одна популяция, конверсию
    // можно писать в шапке строки.
    periodAnchor: 'first' as const,
  }), [period, departmentIds, manager, dealScope, clientType]);

  const { data, isLoading, error } = useQuery<MatrixResponse>({
    queryKey: ['transition-matrix', body],
    queryFn: () => fetchMatrix(body),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Второй период — отдельным запросом тем же роутом (движок трогать не нужно:
  // матрица за период сравнения считается теми же правилами).
  const compBody = useMemo(() => ({
    ...body,
    period: { from: comparison.from.toISOString(), to: comparison.to.toISOString() },
  }), [body, comparison]);
  const { data: compData, isLoading: compLoading } = useQuery<MatrixResponse>({
    queryKey: ['transition-matrix', compBody],
    queryFn: () => fetchMatrix(compBody),
    enabled: withComparison,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Категории: в режиме сравнения объединяем оба периода — иначе категория,
  // которая просела до нуля, просто исчезла бы из матрицы, а это самое
  // интересное для владельца («что просело»). Порядок — по объёму отгрузок
  // текущего периода, затем периода сравнения.
  const allCats = useMemo(() => {
    const cur = data?.categories ?? [];
    if (!withComparison || !compData) return cur;
    const extra = (compData.categories ?? []).filter(c => !cur.includes(c));
    return [...cur, ...extra.sort((a, b) => (compData.shipments[b] ?? 0) - (compData.shipments[a] ?? 0))];
  }, [data, compData, withComparison]);
  const shownCats = useMemo(() => (selected.size === 0 ? allCats : allCats.filter(c => selected.has(c))), [allCats, selected]);
  const cellMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data?.cells ?? []) m.set(`${c.from}→${c.to}`, c.n);
    return m;
  }, [data]);
  const compCellMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of compData?.cells ?? []) m.set(`${c.from}→${c.to}`, c.n);
    return m;
  }, [compData]);

  // Доля ячейки в процентах — она же ключ сортировки (сортируем по видимой
  // цифре; при равенстве — по числу переходов, чтобы 100% от одной пары не
  // обгоняли 60% от пятидесяти).
  const pctOf = (from: string, to: string) => {
    const total = data?.rowTotals[from] ?? 0;
    const n = cellMap.get(`${from}→${to}`) ?? 0;
    return { pct: total > 0 ? (n / total) * 100 : 0, n };
  };
  const cmp = (a: { pct: number; n: number }, b: { pct: number; n: number }) => b.pct - a.pct || b.n - a.n;

  const rows = useMemo(() => {
    if (sort?.kind !== 'rows') return shownCats;
    const out = [...shownCats].sort((a, b) => cmp(pctOf(a, sort.key), pctOf(b, sort.key)));
    return sort.dir === 'asc' ? out.reverse() : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownCats, sort, cellMap, data]);
  const cols = useMemo(() => {
    if (sort?.kind !== 'cols') return shownCats;
    const out = [...shownCats].sort((a, b) => cmp(pctOf(sort.key, a), pctOf(sort.key, b)));
    return sort.dir === 'asc' ? out.reverse() : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownCats, sort, cellMap, data]);
  const sortMark = (kind: 'rows' | 'cols', key: string) =>
    sort && sort.kind === kind && sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '';
  const toggle = (cat: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    return next;
  });

  return (
    // Скролл живёт на контейнере ТАБЛИЦЫ, а не на странице: только так шапка
    // матрицы и первая колонка могут прилипать (sticky работает внутри
    // скроллящегося предка), а заголовок с фильтрами остаётся на экране.
    <div className="h-full overflow-hidden flex flex-col">
      <div className="shrink-0 px-3 sm:px-6 py-3 border-b border-[var(--color-border)]">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Матрица переходов</h1>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          Факт: строка — что отгрузили, колонка — что отгрузили следующим. В ячейке — в скольких процентах
          повторных покупок после строки брали колонку (и число таких случаев). Категории — по всем товарным
          позициям заказа, поэтому один заказ из двух категорий попадает в обе колонки, и строка может дать
          больше 100 %. Фильтры режут закрывающую отгрузку пары; предыдущая — из всей истории заказчика.
          Сервисные группы (перевозка, аренда техники) и группа «Разное» в матрице не участвуют: «Разное» —
          не спрос, а сопутствующая мелочь (упаковка, крепёж, ленты), прицепленная к каждому пятому заказу.
        </p>
      </div>

      <div className="shrink-0 flex items-center gap-2 px-3 sm:px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
        {/* Пикер периода сравнения появляется ровно как в основных отчётах —
            тот же PeriodRangeControls, только второй диапазон под тумблером. */}
        <PeriodRangeControls
          period={period} comparison={comparison}
          onPeriodChange={setPeriod} onComparisonChange={setComparison}
          showComparison={withComparison}
        />
        <DepartmentPicker departmentIds={departmentIds} onDepartmentIdsChange={setDepartmentIds} />
        <ManagerPicker value={manager} onChange={setManager} />
        <Segmented ariaLabel="Воронка" value={dealScope} onChange={setDealScope}
          options={[{ key: 'all', label: 'Все' }, { key: 'primary', label: 'Перв.' }, { key: 'repeat', label: 'Повт.' }]} />
        <Segmented ariaLabel="Тип клиента" value={clientType} onChange={setClientType}
          options={[{ key: 'all', label: 'ЧЛ+ЮЛ' }, { key: 'b2c', label: 'ЧЛ' }, { key: 'b2b', label: 'ЮЛ' }]} />
        <button
          type="button"
          onClick={() => setWithComparison(v => !v)}
          aria-pressed={withComparison}
          title="Показать в ячейке второй период и куда двинулся показатель"
          className={`min-h-11 sm:min-h-0 sm:py-1.5 px-3 flex items-center gap-1.5 border rounded-lg text-sm transition-colors ${
            withComparison
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
              : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
          }`}
        >
          <ArrowLeftRight size={14} /> Со сравнением
        </button>
        <Popover
          trigger={
            <button type="button" className="min-h-11 sm:min-h-0 sm:py-1.5 px-3 flex items-center gap-1.5 border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors">
              <Filter size={14} /> Категории
              {selected.size > 0 && <span className="px-1.5 py-0.5 text-[11px] rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)]">{selected.size}</span>}
            </button>
          }
        >
          <div className="max-h-[60vh] overflow-y-auto p-2 w-72 max-w-[94vw]">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-xs font-medium text-[var(--color-text-muted)]">{selected.size === 0 ? 'Показаны все категории' : `Выбрано: ${selected.size}`}</span>
              {selected.size > 0 && (
                <button type="button" onClick={() => setSelected(new Set())} className="tap-target text-xs text-[var(--color-accent)] hover:underline flex items-center gap-0.5"><X size={12} /> Сбросить</button>
              )}
            </div>
            {allCats.map(cat => (
              <label key={cat} className="flex items-center gap-2 px-1 py-1.5 text-sm text-[var(--color-text)] cursor-pointer hover:bg-[var(--color-bg-hover)] rounded">
                <input type="checkbox" checked={selected.size === 0 || selected.has(cat)} onChange={() => toggle(cat)} className="shrink-0" />
                <span className="min-w-0 break-words">{cat}</span>
                <span className="ml-auto text-xs text-[var(--color-text-muted)] shrink-0">{data?.rowTotals[cat] ?? 0}</span>
              </label>
            ))}
          </div>
        </Popover>
        {data && (
          <span className="text-xs text-[var(--color-text-muted)]">
            отгрузок в срезе: <b className="text-[var(--color-text)] tabular-nums">{data.shipmentsTotal.toLocaleString('ru-RU')}</b>
            {' · '}с повтором: <b className="text-[var(--color-text)] tabular-nums">{data.total.toLocaleString('ru-RU')}</b>
            {data.shipmentsTotal > 0 && ` (${((data.total / data.shipmentsTotal) * 100).toFixed(0)} %)`}
            {selected.size > 0 && ' · часть переходов ушла в скрытые категории'}
          </span>
        )}
        {withComparison && (
          <span className="text-xs text-[var(--color-text-muted)]">
            {compLoading ? 'считаем сравнение…' : (
              <>в ячейке: <b className="text-[var(--color-text)]">↖ период</b> · <b>↘ сравнение</b>;
              {' '}цвет — <b className="text-[var(--color-positive)]">рост</b>,
              {' '}<b className="text-[var(--color-negative)]">просадка</b>,
              {' '}серый — стагнация (±1 п.п.)</>
            )}
          </span>
        )}
      </div>

      {error ? (
        <div className="p-10 text-center text-sm text-[var(--color-negative,#d33)]">{error instanceof Error ? error.message : String(error)}</div>
      ) : isLoading ? (
        <div className="p-6 space-y-3">{Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />)}</div>
      ) : shownCats.length === 0 ? (
        <div className="p-10 text-center text-sm text-[var(--color-text-muted)]">Нет повторных покупок за выбранный период в этом срезе</div>
      ) : (
        // Отступ от краёв экрана — на ВНЕШНЕМ, нескроллящемся блоке. Раньше
        // px-3/sm:px-6 стояли на самом скролл-контейнере, и `sticky left-0`
        // прилипал к краю КОНТЕНТ-бокса (после паддинга) — в полосе паддинга
        // просвечивали уезжающие колонки (жалоба владельца 11.09).
        // border-separate вместо collapse: со collapse у sticky-ячеек
        // «разъезжаются» границы, а фоны местами просвечивают.
        <div className="flex-1 min-h-0 px-3 sm:px-6 pb-3">
          <div className="h-full overflow-auto">
            <table className="border-separate border-spacing-0 text-base">
              <thead>
                <tr>
                  {/* Угол: прилипает и по вертикали, и по горизонтали — поверх обеих шапок. */}
                  <th className="sticky left-0 top-0 z-30 bg-[var(--color-bg)] text-left p-3 text-sm font-medium text-[var(--color-text-muted)] border-b border-r border-[var(--color-border)] min-w-[260px] max-w-[320px]">
                    Отгрузили ↓ / следующим →
                    {sort && (
                      <button
                        type="button"
                        onClick={() => setSort(null)}
                        className="tap-target ml-2 text-xs text-[var(--color-accent)] hover:underline"
                      >
                        сбросить сортировку
                      </button>
                    )}
                  </th>
                  {cols.map(to => (
                    <th
                      key={to}
                      className="sticky top-0 z-20 bg-[var(--color-bg)] p-0 text-sm font-medium text-[var(--color-text)] border-b border-[var(--color-border)] align-bottom"
                      style={{ minWidth: withComparison ? 150 : 72 }}
                    >
                      {/* Клик по колонке → строки от большего к меньшему по ней. */}
                      <button
                        type="button"
                        onClick={() => setSort(s => nextSort(s, 'rows', to))}
                        title={`Сортировать строки по «${to}» (сверху вниз от большего)`}
                        className={`w-full p-2 flex items-end justify-center hover:bg-[var(--color-bg-hover)] transition-colors ${
                          sort?.kind === 'rows' && sort.key === to ? 'text-[var(--color-accent)]' : ''
                        }`}
                      >
                        <span className="[writing-mode:vertical-rl] rotate-180 max-h-56 overflow-hidden text-ellipsis whitespace-nowrap" title={to}>
                          {to}{sortMark('rows', to)}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(from => {
                  const total = data?.rowTotals[from] ?? 0;
                  const ship = data?.shipments[from] ?? 0;
                  const cTotal = compData?.rowTotals[from] ?? 0;
                  const cShip = compData?.shipments[from] ?? 0;
                  const conv = ship > 0 ? (total / ship) * 100 : 0;
                  const cConv = cShip > 0 ? (cTotal / cShip) * 100 : 0;
                  const convDelta = deltaOf(conv, cConv, cShip > 0);
                  return (
                    <tr key={from}>
                      <th className="sticky left-0 z-10 bg-[var(--color-bg)] text-left p-0 font-normal text-[var(--color-text)] border-b border-r border-[var(--color-border)] min-w-[260px] max-w-[320px]">
                        {/* Клик по строке → колонки от большего к меньшему по ней. */}
                        <button
                          type="button"
                          onClick={() => setSort(s => nextSort(s, 'cols', from))}
                          title={`Сортировать колонки по строке «${from}» (слева направо от большего)`}
                          className={`w-full text-left p-3 hover:bg-[var(--color-bg-hover)] transition-colors ${
                            sort?.kind === 'cols' && sort.key === from ? 'text-[var(--color-accent)]' : ''
                          }`}
                        >
                          <span className="block break-words leading-tight">{from}{sortMark('cols', from)}</span>
                          {/* Конверсия категории в повторную покупку: сколько отгрузок было
                              в срезе и у скольких из них случилось продолжение. */}
                          <span className="block mt-0.5 text-xs text-[var(--color-text-muted)]">
                            {ship.toLocaleString('ru-RU')} отгр. · {total} повт.
                            {ship > 0 && <b className="ml-1 text-[var(--color-text)]">{conv.toFixed(0)} %</b>}
                            {withComparison && (
                              <span className={`block ${DELTA_CLS[convDelta]}`}>
                                было: {cShip.toLocaleString('ru-RU')} отгр. · {cTotal} повт.
                                {cShip > 0 && ` · ${cConv.toFixed(0)} %`}
                              </span>
                            )}
                          </span>
                        </button>
                      </th>
                      {cols.map(to => {
                        const n = cellMap.get(`${from}→${to}`) ?? 0;
                        const pct = total > 0 ? (n / total) * 100 : 0;
                        const cn = compCellMap.get(`${from}→${to}`) ?? 0;
                        const cPct = cTotal > 0 ? (cn / cTotal) * 100 : 0;
                        const d = deltaOf(pct, cPct, cTotal > 0);
                        const empty = withComparison ? n === 0 && cn === 0 : n === 0;
                        const title = withComparison
                          ? `После «${from}» брали «${to}»\nпериод: ${n} из ${total} повт. (${pctStr(pct)})\nсравнение: ${cn} из ${cTotal} повт. (${cTotal > 0 ? pctStr(cPct) : '—'})\nКлик — кто продаёт и цепочки сделок`
                          : `После «${from}» брали «${to}»: ${n} из ${total} повторных покупок (${ship} отгрузок категории). Клик — кто продаёт и цепочки сделок`;
                        return (
                          <td key={to}
                            className={`border-b border-[var(--color-border)] tabular-nums ${from === to ? 'font-medium' : ''}`}
                            style={{ background: n > 0 ? heatBg(pct) : undefined }}>
                            {empty ? (
                              <span className="block p-2 text-center text-[var(--color-text-muted)]">·</span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDrill({ from, to })}
                                title={title}
                                className="w-full min-h-11 hover:outline hover:outline-2 hover:outline-[var(--color-accent)] rounded"
                              >
                                {withComparison ? (
                                  /* Ячейка поделена по диагонали (правка владельца 11.09):
                                     сверху-слева — выбранный период, снизу-справа — период
                                     сравнения. Цвет верхнего значения = рост / просадка /
                                     стагнация. Сетка вчетверо крупнее, чтобы всё влезло. */
                                  <span className="relative block h-[68px] w-full">
                                    <span
                                      aria-hidden
                                      className="absolute inset-0"
                                      /* Линия делителя — от приглушённого текста, а не
                                         --color-border: на плотной heat-заливке бордюрный
                                         цвет сливается с фоном (проверено на стенде). */
                                      style={{ background: 'linear-gradient(to top right, transparent calc(50% - 0.5px), color-mix(in srgb, var(--color-text-muted) 60%, transparent) calc(50% - 0.5px), color-mix(in srgb, var(--color-text-muted) 60%, transparent) calc(50% + 0.5px), transparent calc(50% + 0.5px))' }}
                                    />
                                    <span className={`absolute top-1 left-2 leading-tight text-left ${DELTA_CLS[d]}`}>
                                      <span className="block font-semibold">{n > 0 ? pctStr(pct) : '—'}</span>
                                      <span className="block text-[11px] opacity-80">{n > 0 ? n : ''}</span>
                                    </span>
                                    <span className="absolute bottom-1 right-2 leading-tight text-right text-[var(--color-text-muted)]">
                                      <span className="block text-sm">{cTotal > 0 && cn > 0 ? pctStr(cPct) : '—'}</span>
                                      <span className="block text-[11px]">{cn > 0 ? cn : ''}</span>
                                    </span>
                                  </span>
                                ) : (
                                  <span className="px-2 py-2 flex flex-col leading-tight items-center justify-center">
                                    <span className="font-medium">{pctStr(pct)}</span>
                                    <span className="text-xs text-[var(--color-text-muted)]">{n}</span>
                                  </span>
                                )}
                              </button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    {drill && (
        <TransitionDrillModal from={drill.from} to={drill.to} filters={body} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
