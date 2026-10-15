'use client';
// «Реализация → Ответы на запросы → Доля запросов» (методика Панели снабжения):
// у какой доли сделок по каталогу есть запросы снабжению. Период — дата создания сделки.
// Дерево — /api/realizations/supply/dom; клик по числу сделок — список сделок узла
// (/dom-deals, kind dom|has) в выезжающей панели. Период, регион и сортировка — в URL.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, Info, Loader2 } from 'lucide-react';
import { defaultPeriod as reportDefaultPeriod, recomputeComparison, type DateRange } from '@/lib/period';
import { useUrlState, dateRangeParam, stringParam } from '@/lib/hooks/useUrlState';
import { useUrlSort, sortRows } from '@/lib/hooks/useUrlSort';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { SidePanelShell } from '@/features/reports/ui/SidePanelShell';
import { SortableTh } from '@/components/ui/SortableTh';
import { mskYmd } from '@/lib/realizations/period';
import type { DomRow } from '@/lib/supplyPanel/metrics';
import { DASH, fmtDateTime, fmtInt, fmtPct, fmtRub } from './format';
import { fmtPulled, getSupply, type DomDealOut, type DomTree, type SupplyMeta, type WithPulled } from './supplyShared';

const selectCls = 'focus-ring h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 text-[16px] sm:text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)]';
const tdCls = 'border-b border-[var(--color-table-row-border,var(--color-border))] px-2 h-[34px] whitespace-nowrap text-right tabular-nums';

type Key = 'name' | 'deals' | 'req' | 'share_pct' | 'tasks' | 'amount' | 'sold' | 'has' | 'has_req' | 'has_share_pct';
const KEYS: readonly Key[] = ['name', 'deals', 'req', 'share_pct', 'tasks', 'amount', 'sold', 'has', 'has_req', 'has_share_pct'];
const KIND_TITLE: Record<string, string> = { s: 'раздел каталога', p: 'карточка товара', o: 'торговое предложение', _: 'сделки без позиций из каталога или с нулевыми суммами' };
const UNDEF = '_undef';

interface DealsResp { total: number; shown: number; rows: DomDealOut[] }

export function SupplySharePage() {
  const initialPeriod = useMemo(() => reportDefaultPeriod(), []);
  const [period, setPeriod] = useUrlState<DateRange>('period', dateRangeParam(initialPeriod));
  const [region, setRegion] = useUrlState<string>('region', stringParam(''));
  const { sort, toggle } = useUrlSort<Key>('sort', KEYS, { key: 'deals', dir: 'desc' });
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [drill, setDrill] = useState<{ node: string; kind: 'dom' | 'has'; name: string } | null>(null);

  const meta = useQuery<SupplyMeta>({ queryKey: ['realizations', 'supply', 'meta'], queryFn: () => getSupply('/api/realizations/supply/meta'), staleTime: 5 * 60_000 });
  const qs = new URLSearchParams({ from: mskYmd(period.from), to: mskYmd(period.to), ...(region ? { region } : {}) });
  const q = useQuery<WithPulled<DomTree>>({
    queryKey: ['realizations', 'supply', 'dom', qs.toString()],
    queryFn: () => getSupply(`/api/realizations/supply/dom?${qs}`),
    staleTime: 60_000,
  });

  const getVal = (r: DomRow, k: Key): number | string | null => (k === 'name' ? r.name : r[k]);
  // «Не определено» всегда в конце.
  const order = (rows: DomRow[]) => {
    const sorted = sortRows(rows, sort, getVal);
    return [...sorted.filter(r => r.key !== UNDEF), ...sorted.filter(r => r.key === UNDEF)];
  };
  const toggleOpen = (k: string) => setOpen(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const tree = q.data;
  const lines: { r: DomRow; lvl: number; key: string }[] = [];
  if (tree) {
    const walk = (rows: DomRow[], lvl: number, path: string) => {
      for (const r of order(rows)) {
        const key = `${path}›${r.key}`;
        lines.push({ r, lvl, key });
        if (r.children && open.has(key)) walk(r.children, lvl + 1, key);
      }
    };
    walk(tree.rows, 0, 'dom');
  }

  const th = (k: Key, label: string, title?: string, sticky = false) => (
    <SortableTh key={k} label={label} title={title} align={k === 'name' ? 'left' : 'right'} sticky={sticky} active={sort.key === k} dir={sort.dir} onClick={() => toggle(k)} />
  );
  const link = 'focus-ring tap-target rounded-sm font-medium text-[var(--brand)] hover:underline tabular-nums';
  const num = (r: DomRow, v: number, kind: 'dom' | 'has' | null) => (
    <td className={tdCls}>
      {kind && v && r.key ? <button type="button" onClick={() => setDrill({ node: r.key, kind, name: r.name })} className={link} title="Список сделок">{fmtInt(v)}</button> : fmtInt(v)}
    </td>
  );
  const cells = (r: DomRow, clickable: boolean) => (
    <>
      {num(r, r.deals, clickable ? 'dom' : null)}
      {num(r, r.req, clickable ? 'dom' : null)}
      <td className={`${tdCls} ${r.share_pct !== null && r.share_pct >= 50 ? 'font-semibold text-[var(--warning-text)]' : ''}`}>{fmtPct(r.share_pct)}</td>
      <td className={tdCls}>{fmtInt(r.tasks)}</td>
      <td className={tdCls}>{fmtRub(r.amount)}</td>
      <td className={tdCls}>{fmtInt(r.sold)}{r.sold && r.sold_pct !== null ? <span className="ml-1 text-xs text-[var(--color-text-muted)]">{fmtPct(r.sold_pct)}</span> : null}</td>
      {num(r, r.has, clickable ? 'has' : null)}
      {num(r, r.has_req, clickable ? 'has' : null)}
      <td className={tdCls}>{fmtPct(r.has_share_pct)}</td>
    </>
  );

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[var(--color-bg)]">
      <div className="flex flex-col gap-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Доля запросов</h1>
          {q.data?.pulledAt ? <span className="text-[13px] text-[var(--color-text-muted)]">{fmtPulled(q.data.pulledAt)}</span> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2">
          <PeriodRangeControls period={period} comparison={recomputeComparison(period)} showComparison={false}
            onPeriodChange={p => setPeriod(p)} onComparisonChange={() => {}} />
          <select aria-label="Регион" value={region} onChange={e => setRegion(e.target.value)} className={selectCls}>
            <option value="">Все регионы</option>
            {(meta.data?.regions ?? []).map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div role="status" className="flex items-start gap-2 rounded-lg border border-[var(--color-accent)]/25 bg-[var(--blue-50)] px-3 py-2 text-[13px] text-[var(--color-text)]">
          <Info size={16} className="mt-px shrink-0 text-[var(--color-accent)]" aria-hidden />
          <span>
            Период — по дате создания сделки. «По наибольшему»: сделка относится к разделу каталога, на который в ней больше всего денег;
            «с запросом» — по сделке есть задача снабжению, «доля» — с запросом / сделок. «По наличию»: сделка учитывается в каждом разделе, где у неё есть позиция.
            «Не определено» — сделки без позиций из каталога. Время — МСК.
          </span>
        </div>

        {q.isLoading && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Считаем доли…</div>}
        {q.error && <div className="rounded-lg border border-[var(--danger-text)]/30 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]">{(q.error as Error).message}</div>}
        {tree && (tree.rows.length === 0 ? (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-12 text-center text-[13px] text-[var(--color-text-muted)]">
            За период нет сделок с товарами.
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <div className="scroll-x max-h-[70dvh] overflow-auto">
              <table className="w-full border-collapse text-[13px] text-[var(--color-text)]">
                <thead>
                  <tr>
                    <th className="sticky top-0 left-0 z-30 bg-[var(--color-table-header)] h-[28px]" />
                    <th colSpan={6} className="sticky top-0 z-20 bg-[var(--color-table-header)] px-2 text-center text-xs font-semibold text-[var(--color-text-muted)] border-l border-[var(--color-border)]">По наибольшему (доминирует в сделке)</th>
                    <th colSpan={3} className="sticky top-0 z-20 bg-[var(--color-table-header)] px-2 text-center text-xs font-semibold text-[var(--color-text-muted)] border-l border-[var(--color-border)]">По наличию (есть в сделке)</th>
                  </tr>
                  <tr>
                    {th('name', 'Раздел каталога / товар / предложение', undefined, true)}
                    {th('deals', 'Сделок')}
                    {th('req', 'С запросом', 'Сделки, по которым есть запрос снабжению')}
                    {th('share_pct', 'Доля запросов, %')}
                    {th('tasks', 'Запросов, задач')}
                    {th('amount', 'Сумма сделок')}
                    {th('sold', 'Продано', 'Сделок · доля')}
                    {th('has', 'С позицией')}
                    {th('has_req', 'С запросом', 'Среди сделок с позицией')}
                    {th('has_share_pct', 'Доля запросов, %')}
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
      {drill && <DealsPanel key={`${drill.node}|${drill.kind}`} {...drill} period={period} region={region} onClose={() => setDrill(null)} />}
    </div>
  );
}

/** Сделки узла дерева: kind=dom — где узел доминирует, has — где есть позиция узла. */
function DealsPanel({ node, kind, name, period, region, onClose }: {
  node: string; kind: 'dom' | 'has'; name: string; period: DateRange; region: string; onClose: () => void;
}) {
  const qs = new URLSearchParams({ from: mskYmd(period.from), to: mskYmd(period.to), node, kind, ...(region ? { region } : {}) });
  const q = useQuery<WithPulled<DealsResp>>({
    queryKey: ['realizations', 'supply', 'dom-deals', qs.toString()],
    queryFn: () => getSupply(`/api/realizations/supply/dom-deals?${qs}`),
    staleTime: 60_000,
  });
  const rows = q.data?.rows ?? [];
  const td = 'border-b border-[var(--color-table-row-border,var(--color-border))] px-2 h-[34px] whitespace-nowrap';
  const link = 'focus-ring rounded-sm font-medium text-[var(--brand)] hover:underline tabular-nums';
  return (
    <SidePanelShell ariaLabel={`Сделки: ${name}`} title={name} badge={kind === 'dom' ? 'Доминирует в сделке' : 'Есть позиция'}
      subtitle={<>{mskYmd(period.from)} — {mskYmd(period.to)} · по дате создания сделки{q.data?.pulledAt ? ` · ${fmtPulled(q.data.pulledAt)}` : ''}</>}
      onClose={onClose}>
      {q.isLoading && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Загружаем сделки…</div>}
      {q.error && <div className="m-3 sm:mx-6 rounded-lg border border-[var(--color-negative)]/40 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]">{(q.error as Error).message}</div>}
      {q.data && (rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">Сделок нет.</div>
      ) : (
        <>
          <div className="px-3 sm:px-6 py-2 text-[13px] font-semibold text-[var(--color-text)]">
            {fmtInt(q.data.total)} сделок{q.data.shown < q.data.total ? ` (показано ${fmtInt(q.data.shown)})` : ''}
          </div>
          <div className="scroll-x flex-1 min-h-0 overflow-auto border-t border-[var(--color-border)]">
            <table className="w-full border-collapse text-[13px] text-[var(--color-text)]">
              <thead>
                <tr className="text-xs font-semibold text-[var(--color-text-muted)]">
                  {['Сделка', 'Создана', 'Регион', 'Сумма', 'Статус', 'Доминирует', 'Задачи'].map((h, i) => (
                    <th key={h} scope="col" className={`sticky top-0 ${i === 0 ? 'left-0 z-30' : 'z-20'} bg-[var(--color-table-header)] border-b border-[var(--color-border)] px-2 h-[34px] whitespace-nowrap ${i === 3 ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(d => (
                  <tr key={d.deal} className="report-row">
                    <td className={`${td} sticky left-0 z-10 bg-[var(--color-bg)]`}>
                      <a href={d.deal_url} target="_blank" rel="noopener noreferrer" className={`${link} inline-flex items-center gap-1`}>{d.deal}<ExternalLink size={11} aria-hidden /></a>
                    </td>
                    <td className={`${td} tabular-nums`}>{fmtDateTime(d.created)}</td>
                    <td className={td}>{d.region ?? DASH}</td>
                    <td className={`${td} text-right tabular-nums`}>{fmtRub(d.amount)}</td>
                    <td className={td}>
                      {d.sold ? <span className="text-[var(--success-text)]">продана</span> : d.lost ? <span className="text-[var(--danger-text)]">проиграна</span> : DASH}
                    </td>
                    <td className={`${td} max-w-[200px] truncate`} title={d.dominant}>{d.dominant || DASH}</td>
                    <td className={td}>
                      {d.task_urls.length ? d.task_urls.map((u, i) => (
                        <a key={u} href={u} target="_blank" rel="noopener noreferrer" className={`${link} tap-target mr-2`}>#{d.tasks[i]}</a>
                      )) : DASH}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ))}
    </SidePanelShell>
  );
}
