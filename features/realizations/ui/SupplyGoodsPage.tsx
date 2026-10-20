'use client';
// «Реализация → Ответы на запросы → Товары» (методика Панели снабжения, вкладка «Товары»):
// категория запроса (проект) → подкатегория → товар → предложение, по новым запросам
// периода с таблицей товаров. Дерево — /api/realizations/supply/goods, клик по «Запросов» —
// список задач узла (SupplyTasksDrill, metric new + path). Период, фильтры и сортировка — в URL.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Info, Loader2 } from 'lucide-react';
import { defaultPeriod as reportDefaultPeriod, recomputeComparison, type DateRange } from '@/lib/period';
import { useUrlState, dateRangeParam, stringParam } from '@/lib/hooks/useUrlState';
import { useUrlSort, sortRows } from '@/lib/hooks/useUrlSort';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { SortableTh } from '@/components/ui/SortableTh';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { mskYmd } from '@/lib/realizations/period';
import type { GoodsRow } from '@/lib/supplyPanel/metrics';
import { DASH, fmt1, fmtDate, fmtInt, fmtPct } from './format';
import { SupplyTasksDrill } from './SupplyTasksDrill';
import { fmtPulled, getSupply, type GoodsTree, type SupplyMeta, type WithPulled } from './supplyShared';

const selectCls = 'focus-ring h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 text-[16px] sm:text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)]';
const tdCls = 'border-b border-[var(--color-table-row-border,var(--color-border))] px-2 h-[34px] whitespace-nowrap text-right tabular-nums';

type Key = 'name' | 'requests' | 'share_pct' | 'deals' | 'sold' | 'sold_pct' | 'volume';
const KEYS: readonly Key[] = ['name', 'requests', 'share_pct', 'deals', 'sold', 'sold_pct', 'volume'];
const KIND_TITLE: Record<string, string> = {
  s: 'раздел каталога', p: 'карточка товара', o: 'торговое предложение',
  _: 'позиции, которых нет в каталоге', n: 'позиция как записана в запросе',
};
const NONE = '_none';

export function SupplyGoodsPage() {
  const initialPeriod = useMemo(() => reportDefaultPeriod(), []);
  const [period, setPeriod] = useUrlState<DateRange>('period', dateRangeParam(initialPeriod));
  const [region, setRegion] = useUrlState<string>('region', stringParam(''));
  const [dept, setDept] = useUrlState<string>('dept', stringParam(''));
  const [group, setGroup] = useUrlState<string>('group', stringParam(''));
  const { sort, toggle } = useUrlSort<Key>('sort', KEYS, { key: 'requests', dir: 'desc' });
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [drill, setDrill] = useState<{ path: string; name: string } | null>(null);

  const meta = useQuery<SupplyMeta>({ queryKey: ['realizations', 'supply', 'meta'], queryFn: () => getSupply('/api/realizations/supply/meta'), staleTime: 5 * 60_000 });
  const projects = (meta.data?.projects ?? []).filter(p => (!region || p.region === region) && (!dept || p.dept === dept));

  const filter: Record<string, string> = {};
  if (region) filter.region = region;
  if (dept) filter.dept = dept;
  if (group) filter.group = group;
  const qs = new URLSearchParams({ from: mskYmd(period.from), to: mskYmd(period.to), ...filter });
  const q = useQuery<WithPulled<GoodsTree>>({
    queryKey: ['realizations', 'supply', 'goods', qs.toString()],
    queryFn: () => getSupply(`/api/realizations/supply/goods?${qs}`),
    staleTime: 60_000,
  });

  const getVal = (r: GoodsRow, k: Key): number | string | null => (k === 'name' ? r.name : r[k]);
  // «Вне каталога» всегда в конце, как в панели.
  const order = (rows: GoodsRow[]) => {
    const sorted = sortRows(rows, sort, getVal);
    return [...sorted.filter(r => r.key !== NONE), ...sorted.filter(r => r.key === NONE)];
  };
  const toggleOpen = (k: string) => setOpen(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const tree = q.data;
  const lines: { r: GoodsRow; lvl: number; key: string }[] = [];
  if (tree) {
    const walk = (rows: GoodsRow[], lvl: number, path: string) => {
      for (const r of order(rows)) {
        const key = `${path}›${r.key}`;
        lines.push({ r, lvl, key });
        if (r.children && open.has(key)) walk(r.children, lvl + 1, key);
      }
    };
    walk(tree.rows, 0, 'goods');
  }

  const th = (k: Key, label: string, align: 'left' | 'right' = 'right', sticky = false, title?: string) => (
    <SortableTh key={k} label={label} title={title} align={align} sticky={sticky} active={sort.key === k} dir={sort.dir} onClick={() => toggle(k)} />
  );
  const cells = (r: GoodsRow, clickable: boolean) => (
    <>
      <td className={tdCls}>
        {clickable && r.requests ? (
          <button type="button" onClick={() => setDrill({ path: r.path, name: r.name })} title="Список запросов"
            className="focus-ring tap-target rounded-sm font-medium text-[var(--brand)] hover:underline tabular-nums">{fmtInt(r.requests)}</button>
        ) : fmtInt(r.requests)}
      </td>
      <td className={tdCls}>{fmtPct(r.share_pct)}</td>
      <td className={tdCls}>{fmtInt(r.deals)}</td>
      <td className={tdCls}>{fmtInt(r.sold)}</td>
      <td className={tdCls}>{fmtPct(r.sold_pct)}</td>
      <td className={tdCls}>
        {r.volume === null || r.volume === undefined ? DASH : (Number.isInteger(r.volume) ? fmtInt(r.volume) : fmt1(r.volume))}
        {r.volume !== null && r.unit ? <small className="ml-1 text-[var(--color-text-muted)]">{r.unit}</small> : null}
        {r.units > 1 ? <span className="ml-1 text-xs text-[var(--color-text-muted)]" title={`Ещё ${r.units - 1} ед. измерения в запросах`}>+{r.units - 1}</span> : null}
      </td>
    </>
  );

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[var(--color-bg)]">
      <div className="flex flex-col gap-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Товары в запросах</h1>
          {tree && q.data?.pulledAt ? <span className="text-[13px] text-[var(--color-text-muted)]">{fmtPulled(q.data.pulledAt)}</span> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2">
          <PeriodRangeControls period={period} comparison={recomputeComparison(period)} showComparison={false}
            onPeriodChange={p => setPeriod(p)} onComparisonChange={() => {}} />
          <select aria-label="Регион" value={region} onChange={e => { setRegion(e.target.value); setGroup(''); }} className={selectCls}>
            <option value="">Все регионы</option>
            {(meta.data?.regions ?? []).map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select aria-label="Департамент" value={dept} onChange={e => { setDept(e.target.value); setGroup(''); }} className={selectCls}>
            <option value="">Все департаменты</option>
            {(meta.data?.depts ?? []).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <SearchSelect ariaLabel="Категория" allLabel="Все категории" searchPlaceholder="Поиск категории"
            options={projects.map(p => ({ value: String(p.id), label: p.name }))}
            value={group} onChange={setGroup} className="max-w-full sm:max-w-[260px]" />
        </div>

        <div role="status" className="flex items-start gap-2 rounded-lg border border-[var(--color-accent)]/25 bg-[var(--blue-50)] px-3 py-2 text-[13px] text-[var(--color-text)]">
          <Info size={16} className="mt-px shrink-0 text-[var(--color-accent)]" aria-hidden />
          <span>
            Считаются новые запросы периода, в которых есть таблица товаров
            {meta.data?.goodsSince ? <> (данные о товарах есть в запросах с {fmtDate(meta.data.goodsSince)})</> : null}.
            Услуги не считаются. «Доля» — от родительского узла, «Продано» — сделки с продажей. Время — МСК.
          </span>
        </div>

        {q.isLoading && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Загружаем товары…</div>}
        {q.error && <div className="rounded-lg border border-[var(--danger-text)]/30 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]">{(q.error as Error).message}</div>}
        {tree && (tree.rows.length === 0 ? (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-12 text-center text-[13px] text-[var(--color-text-muted)]">
            За период нет запросов с таблицей товаров.
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <div className="scroll-x max-h-[70dvh] overflow-auto">
              <table className="w-full border-collapse text-[13px] text-[var(--color-text)]">
                <thead>
                  <tr>
                    {th('name', 'Раздел каталога / товар / предложение', 'left', true)}
                    {th('requests', 'Запросов', 'right', false, 'Новые запросы периода с позицией из узла')}
                    {th('share_pct', 'Доля от родителя, %')}
                    {th('deals', 'Сделок')}
                    {th('sold', 'Продано, сделок')}
                    {th('sold_pct', 'Продано, %')}
                    {th('volume', 'Объём', 'right', false, 'В единице, в которой товар просят чаще всего')}
                  </tr>
                </thead>
                <tbody>
                  {lines.map(({ r, lvl, key }) => {
                    const isOpen = open.has(key);
                    return (
                      <tr key={key} className="report-row">
                        <td className="sticky left-0 z-10 bg-[var(--color-bg-surface)] border-b border-[var(--color-table-row-border,var(--color-border))] px-2 h-[34px] max-w-[220px] sm:max-w-[420px]"
                          style={{ paddingLeft: 8 + lvl * 16 }} title={`${r.name} — ${KIND_TITLE[r.kind] ?? ''}`}>
                          {r.children ? (
                            <button type="button" onClick={() => toggleOpen(key)} aria-expanded={isOpen}
                              className="focus-ring tap-target flex max-w-full items-center gap-1 rounded-sm text-left">
                              {isOpen ? <ChevronDown size={14} aria-hidden className="shrink-0" /> : <ChevronRight size={14} aria-hidden className="shrink-0" />}
                              <span className={`truncate ${lvl === 0 ? 'font-semibold' : ''}`}>{r.name}</span>
                            </button>
                          ) : <span className="block truncate pl-[18px]">{r.name}</span>}
                        </td>
                        {cells(r, true)}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="sticky left-0 z-10 bg-[var(--color-bg-surface)] px-2 h-[34px] border-t border-[var(--color-border)]">Итого</td>
                    {cells(tree.total, false)}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ))}
      </div>
      {drill && (
        <SupplyTasksDrill key={drill.path} filter={{ ...filter, path: drill.path }} metric="new" name={drill.name} metricName="Запросы с товаром"
          period={period} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
