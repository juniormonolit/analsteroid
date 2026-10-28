'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Search } from 'lucide-react';
import { ENTITY_COLOR } from '@/lib/metrics/entity-colors';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { ProductDetailResponse, ProductDetailRow, ProductStatus } from '@/features/reports/engine/productDetail';

// ── «По товарам: детально» (задача владельца 28.10.2026) ────────────────────
// Альтернативный путь дрилл-дауна: те же сделки, что в плоском списке, разложенные
// по уникальным товарам их позиций. Определения статусов и сумм — в
// features/reports/engine/productDetail.ts. Каждая цифра (кроме процентов)
// кликабельна → список сделок «с этим товаром [в этом статусе]» — тот же
// DealsListBody, что у обычного дрилла (передаётся снаружи через renderDeals,
// чтобы не зацикливать импорт с DrilldownDrawer).

type ColKey = 'deals' | 'share' | 'sold' | 'shipped' | 'crSale' | 'crShip' | 'amount' | 'soldAmount'
  | 'shippedAmount' | 'lost' | 'lostAmount' | 'noStock' | 'expensive';

interface Col {
  key: ColKey;
  label: string;
  kind: 'count' | 'money' | 'pct';
  /** Статус для клика; undefined у счётчика/суммы — все сделки с товаром; null — не кликается. */
  status?: ProductStatus | null;
  color?: string | null;
  title: string;
}

const COLS: Col[] = [
  { key: 'deals', label: 'Сделок', kind: 'count', title: 'Сделок, в позициях которых есть товар' },
  { key: 'share', label: 'Доля сделок', kind: 'pct', status: null, title: 'Сделок с товаром от всех сделок выборки' },
  { key: 'sold', label: 'В продаже', kind: 'count', status: 'sale', color: ENTITY_COLOR.sale, title: 'Сделок с товаром, сейчас на стадии продажи или отгрузки' },
  { key: 'shipped', label: 'В отгрузке', kind: 'count', status: 'shipment', color: ENTITY_COLOR.shipment, title: 'Сделок с товаром, сейчас на стадии отгрузки' },
  { key: 'crSale', label: 'CR → продажа', kind: 'pct', status: null, color: ENTITY_COLOR.sale, title: 'В продаже ÷ сделок с товаром' },
  { key: 'crShip', label: 'CR → отгрузка', kind: 'pct', status: null, color: ENTITY_COLOR.shipment, title: 'В отгрузке ÷ сделок с товаром' },
  { key: 'amount', label: 'Сумма товара', kind: 'money', title: 'Сумма позиций этого товара во всех сделках' },
  { key: 'soldAmount', label: 'Сумма продаж', kind: 'money', status: 'sale', color: ENTITY_COLOR.sale, title: 'Сумма позиций товара в сделках на стадии продажи/отгрузки' },
  { key: 'shippedAmount', label: 'Сумма отгрузок', kind: 'money', status: 'shipment', color: ENTITY_COLOR.shipment, title: 'Сумма позиций товара в сделках на стадии отгрузки' },
  { key: 'lost', label: 'Отказов', kind: 'count', status: 'refusal', color: ENTITY_COLOR.refusal, title: 'Сделок с товаром, сейчас на отказной стадии' },
  { key: 'lostAmount', label: 'Сумма отказов', kind: 'money', status: 'refusal', color: ENTITY_COLOR.refusal, title: 'Сумма позиций товара в проигранных сделках' },
  { key: 'noStock', label: '«Нет в наличии»', kind: 'count', status: 'no_stock', color: ENTITY_COLOR.refusal, title: 'Сделок с товаром, закрытых в стадию «Нет в наличии»' },
  { key: 'expensive', label: '«Дорого»', kind: 'count', status: 'expensive', color: ENTITY_COLOR.refusal, title: 'Сделок с товаром, закрытых в стадии «Дорого…»' },
];

const STATUS_LABEL: Record<ProductStatus, string> = {
  sale: 'в продаже', shipment: 'в отгрузке', refusal: 'отказы', no_stock: '«Нет в наличии»', expensive: '«Дорого»',
};

function value(r: ProductDetailRow, key: ColKey, totalDeals: number): number | null {
  switch (key) {
    case 'share': return totalDeals ? (r.deals / totalDeals) * 100 : null;
    case 'crSale': return r.deals ? (r.sold / r.deals) * 100 : null;
    case 'crShip': return r.deals ? (r.shipped / r.deals) * 100 : null;
    default: return r[key];
  }
}

function fmtValue(v: number | null, kind: Col['kind']): string {
  if (v === null) return '—';
  if (kind === 'pct') return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;
  if (v === 0) return '—';
  if (kind === 'money') return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
  return v.toLocaleString('ru-RU');
}

interface Drill { product: string; status?: ProductStatus; label: string }

export function ProductDetailView({ query, renderDeals }: {
  /** Параметры /api/reports/deals плоского списка этой цели дрилла. */
  query: URLSearchParams;
  renderDeals: (query: URLSearchParams) => React.ReactNode;
}) {
  const qs = query.toString();
  const { data, isLoading, error } = useQuery({
    queryKey: ['drill-products', qs],
    queryFn: async (): Promise<ProductDetailResponse> => {
      const res = await fetch(`/api/reports/deals?${qs}&mode=products`);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const [drill, setDrill] = useState<Drill | null>(null);
  // Сменили фильтры дрилла — открытый список сделок уже не про них.
  useEffect(() => { setDrill(null); }, [qs]);

  const [search, setSearch] = useState('');
  const [hideServices, setHideServices] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: ColKey | 'product'; dir: 'asc' | 'desc' }>({ key: 'deals', dir: 'desc' });

  const allRows = useMemo(() => data?.rows ?? [], [data]);
  const totalDeals = data?.totalDeals ?? 0;
  const groupOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of allRows) {
      if (hideServices && r.service) continue;
      const g = r.group ?? 'Без группы';
      counts.set(g, (counts.get(g) ?? 0) + r.deals);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => ({ value: g, label: g }));
  }, [allRows, hideServices]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const gset = new Set(groups);
    const out = allRows.filter(r =>
      (!hideServices || !r.service)
      && (!gset.size || gset.has(r.group ?? 'Без группы'))
      && (!needle || r.product.toLowerCase().includes(needle)));
    const m = sort.dir === 'asc' ? 1 : -1;
    return out.sort((a, b) => {
      if (sort.key === 'product') return m * a.product.localeCompare(b.product, 'ru');
      return m * ((value(a, sort.key, totalDeals) ?? -1) - (value(b, sort.key, totalDeals) ?? -1));
    });
  }, [allRows, hideServices, groups, search, sort, totalDeals]);

  function onSort(key: ColKey | 'product') {
    setSort(p => p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'product' ? 'asc' : 'desc' });
  }

  if (drill) {
    const q = new URLSearchParams(query);
    q.set('productName', drill.product);
    if (drill.status) q.set('productStatus', drill.status);
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 px-4 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0 min-w-0">
          <button onClick={() => setDrill(null)} className="tap-target flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors shrink-0">
            <ArrowLeft size={14} /> Назад
          </button>
          <span className="text-sm font-medium text-[var(--color-text)] truncate min-w-0">{drill.product}</span>
          <span className="px-2 py-0.5 text-[11px] rounded-full bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)] shrink-0">
            {drill.label}
          </span>
        </div>
        <div className="flex-1 overflow-hidden">{renderDeals(q)}</div>
      </div>
    );
  }

  const noRule = (data as { noRule?: string } | undefined)?.noRule;
  const thBase = 'px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)]';
  const arrow = (k: ColKey | 'product') => sort.key === k ? <span className="ml-0.5 text-[var(--color-accent)]">{sort.dir === 'asc' ? '↑' : '↓'}</span> : null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 sm:px-6 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0 flex-wrap">
        <label className="flex items-center gap-1.5 border border-[var(--color-border)] rounded-lg px-2 min-h-9 bg-[var(--color-bg)] w-full sm:w-64">
          <Search size={13} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Найти товар"
            className="flex-1 min-w-0 bg-transparent outline-none text-base sm:text-xs text-[var(--color-text)]"
          />
        </label>
        <SearchMultiSelect
          ariaLabel="Группа товара"
          options={groupOptions}
          value={groups}
          onChange={setGroups}
          allLabel="Все группы товаров"
          unitLabel="групп"
          className="text-xs"
        />
        <label className="flex items-center gap-1.5 text-xs text-[var(--color-text)] min-h-9 cursor-pointer select-none"
               title="Перевозка, аренда спецтехники и прочие служебные позиции">
          <input type="checkbox" checked={hideServices} onChange={e => setHideServices(e.target.checked)} />
          Без услуг (доставка и т.п.)
        </label>
        <span className="text-xs text-[var(--color-text-muted)] sm:ml-auto">
          {isLoading ? 'Считаю…' : `Товаров: ${rows.length} · сделок в выборке: ${totalDeals.toLocaleString('ru-RU')}${data?.noProductDeals ? `, без позиций: ${data.noProductDeals.toLocaleString('ru-RU')}` : ''}`}
        </span>
      </div>
      <div className="flex-1 min-h-0 scroll-x overflow-y-auto">
        {error ? (
          <div className="px-6 py-4 text-sm text-[var(--color-negative,#e03131)]">Не удалось посчитать товары: {String((error as Error).message).slice(0, 200)}</div>
        ) : noRule ? (
          <div className="px-6 py-4 text-sm text-[var(--color-text-muted)]">У этой метрики нет списка сделок — разложить её по товарам нельзя. Откройте дрилл по строке без метрики.</div>
        ) : !isLoading && rows.length === 0 ? (
          <div className="px-6 py-4 text-sm text-[var(--color-text-muted)]">Нет товаров в сделках выборки</div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-[var(--color-table-header)]">
              <tr>
                <th className="px-2 py-2 font-medium text-[var(--color-text-muted)] text-right">№</th>
                <th className={`${thBase} text-left sticky left-0 z-10 bg-[var(--color-table-header)]`} onClick={() => onSort('product')}>Товар{arrow('product')}</th>
                <th className="px-3 py-2 font-medium text-[var(--color-text-muted)] text-left whitespace-nowrap">Группа</th>
                {COLS.map(c => (
                  <th key={c.key} className={`${thBase} text-right`} title={c.title} onClick={() => onSort(c.key)}>
                    <span className="inline-flex items-center gap-1">
                      {c.color && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />}
                      {c.label}{arrow(c.key)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={COLS.length + 3} className="px-6 py-4 text-[var(--color-text-muted)]">Загрузка…</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={r.product} className={`border-t border-[var(--color-border)] hover:bg-[var(--color-table-row-hover)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}>
                  <td className="px-2 py-[7px] text-right text-[11px] text-[var(--color-text-muted)] tabular-nums">{i + 1}</td>
                  <td className="px-3 py-[7px] sticky left-0 bg-[var(--color-bg)] max-w-[220px] sm:max-w-[380px] truncate text-[var(--color-text)]" title={r.product}>{r.product}</td>
                  <td className="px-3 py-[7px] whitespace-nowrap text-[var(--color-text-muted)] max-w-[160px] truncate" title={r.group ?? ''}>{r.group ?? '—'}</td>
                  {COLS.map(c => {
                    const v = value(r, c.key, totalDeals);
                    const clickable = c.status !== null && v !== null && v !== 0;
                    const text = fmtValue(v, c.kind);
                    return (
                      <td key={c.key} className="px-3 py-[7px] text-right tabular-nums whitespace-nowrap">
                        {clickable ? (
                          <button
                            onClick={() => setDrill({
                              product: r.product,
                              status: c.status ?? undefined,
                              label: c.status ? `${STATUS_LABEL[c.status]} · ${text}` : `все сделки · ${r.deals}`,
                            })}
                            className="text-[var(--color-num,#000)] hover:text-[var(--color-accent)] hover:underline"
                            title={`Сделки с товаром${c.status ? ` — ${STATUS_LABEL[c.status]}` : ''}`}
                          >
                            {text}
                          </button>
                        ) : <span className={c.kind === 'pct' ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}>{text}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
