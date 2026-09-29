'use client';
// «Реализация → Заявки» (задача #8034, переделка #8126 по аудиту Полины). Список
// заявок 1С по плановой дате отгрузки с фильтрами региона / логиста / статуса.
// «Сводка по логистам» и «Регионы» — отдельные отчёты на общем движке
// (/realizations/logists, /realizations/regions), здесь только список.
//
// Всё состояние — в адресе: период (?period= — тот же формат и тот же дефолт, что
// у отчётов «Продаж»), фильтры, сортировка (?sort=), страница (?page=), открытая
// карточка (?request=<id>). Тулбар — компоненты «Продаж» (PeriodRangeControls),
// на телефоне — [период][Фильтры N], остальное раскрывается ниже.
// Доступ — только роль «Администратор» (гейт в layout и во всех API).
// Маржа — без НДС, методика ещё не согласована: подписана «предварительно».

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Loader2, AlertTriangle, Info, Download, RefreshCw, SlidersHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import { RequestCardPanel } from './RequestCardPanel';
import { DASH, fmtDate, fmtInt, fmtMlnRub, fmtPct, fmtRub, humanName } from './format';
import { REGIONS, REGION_LABEL, type Region } from '@/lib/realizations/region';
import { defaultPeriod as reportDefaultPeriod, recomputeComparison, type DateRange } from '@/lib/period';
import { useUrlState, useUrlStateBatch, dateRangeParam, stringParam, intParam } from '@/lib/hooks/useUrlState';
import { useUrlSort, sortRows } from '@/lib/hooks/useUrlSort';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { SortableTh } from '@/components/ui/SortableTh';
import { mskYmd } from '@/lib/realizations/period';

interface LogistOpt { id: string; name: string; region: Region }
interface RequestItem {
  id: string; number: string; docDate: string | null; status: string; grp: 'shipped' | 'cancelled' | 'in_work';
  buyer: string | null; manager: string | null; logistId: string | null; logist: string | null; region: Region;
  shipmentDate: string; salesNv: number | null; purchNv: number | null; purchasesN: number; broken: boolean; marginNv: number | null;
}
interface RequestsResp {
  total: number; truncated: boolean; items: RequestItem[];
  totals: { salesNv: number; purchNv: number; marginNv: number; mSalesNv: number };
  options: { logists: LogistOpt[]; statuses: string[] };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error('Недостаточно прав: раздел «Реализация» доступен только роли «Администратор»');
  if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`);
  return body as T;
}

const PAGE_SIZE = 100;
const selectCls = 'focus-ring h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 text-[16px] sm:text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)]';
const tdCls = 'border-b border-[var(--color-table-row-border,var(--color-border))] px-2 h-[34px] whitespace-nowrap';
const numCls = 'text-right tabular-nums';

/** Бейдж статуса DS: точка + текст, контраст AA (находка 17). */
function StatusBadge({ status, grp }: { status: string; grp: RequestItem['grp'] }) {
  const tone = grp === 'shipped'
    ? 'bg-[var(--success-bg)] text-[var(--success-text)]'
    : grp === 'cancelled' ? 'bg-[var(--danger-bg)] text-[var(--danger-text)]' : 'bg-[var(--blue-50)] text-[var(--brand)]';
  return (
    <span className={`inline-flex max-w-[220px] items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`} title={status}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      <span className="truncate">{status}</span>
    </span>
  );
}

function MarginCell({ v, sales, broken, noPurch, cancelled }: { v: number | null; sales?: number | null; broken?: boolean; noPurch?: boolean; cancelled?: boolean }) {
  if (cancelled) return <span className="text-[var(--color-text-muted)]">{DASH}</span>;
  if (broken) return <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--warning-text)]" title="Сумма закупки задвоена в 1С — заявка не входит в маржу"><AlertTriangle size={12} aria-hidden />закупка задвоена</span>;
  if (noPurch) return <span className="text-xs text-[var(--color-text-muted)]" title="Приобретений нет — себестоимости в 1С нет">нет закупки</span>;
  if (v === null) return <span className="text-[var(--color-text-muted)]">{DASH}</span>;
  const pct = sales ? (100 * v) / sales : null;
  return (
    <span className={v < 0 ? 'text-[var(--danger-text)]' : 'text-[var(--color-text)]'}>
      {fmtRub(v)}{pct !== null && <span className="ml-1 text-xs text-[var(--color-text-muted)]">{fmtPct(pct)}</span>}
    </span>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-3">
      <div className="text-[13px] text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-0.5 text-[20px] sm:text-[28px] leading-tight whitespace-nowrap font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-[var(--color-text-muted)] truncate" title={hint}>{hint}</div>}
    </div>
  );
}

type ReqKey = 'number' | 'docDate' | 'status' | 'buyer' | 'manager' | 'logist' | 'shipmentDate' | 'salesNv' | 'purchNv' | 'marginNv';
const REQ_KEYS: readonly ReqKey[] = ['number', 'docDate', 'status', 'buyer', 'manager', 'logist', 'shipmentDate', 'salesNv', 'purchNv', 'marginNv'];
const REQ_DEFAULT_SORT = { key: 'shipmentDate' as ReqKey, dir: 'desc' as const };

export function RealizationsPage() {
  const sp = useSearchParams();
  const pathname = usePathname();
  const initialPeriod = useMemo(() => {
    // Старые ссылки (?from=&to= ГГГГ-ММ-ДД) — продолжают открывать тот же период.
    const f = sp.get('from'), t = sp.get('to');
    if (f && t && /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return { from: new Date(`${f}T00:00:00+03:00`), to: new Date(`${t}T23:59:59.999+03:00`) };
    }
    return reportDefaultPeriod();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [period, setPeriod] = useUrlState<DateRange>('period', dateRangeParam(initialPeriod));
  const [region, setRegion] = useUrlState<string>('region', stringParam(''));
  const [logist, setLogist] = useUrlState<string>('logist', stringParam(''));
  const [status, setStatus] = useUrlState<string>('status', stringParam(''));
  const [page, setPage] = useUrlState<number>('page', intParam(1));
  const [cardId, setCardId] = useUrlState<string | null>('request', { parse: raw => raw || null, serialize: v => v, default: null, mode: 'push' });
  const { sort, toggle } = useUrlSort<ReqKey>('sort', REQ_KEYS, REQ_DEFAULT_SORT);
  const patch = useUrlStateBatch('replace');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const regionOk = (REGIONS as string[]).includes(region) ? (region as Region) : '';
  const from = mskYmd(period.from), to = mskYmd(period.to);
  const qs = new URLSearchParams({ from, to, ...(regionOk ? { region: regionOk } : {}), ...(logist ? { logist } : {}), ...(status ? { status } : {}) });
  const q = useQuery<RequestsResp>({
    queryKey: ['realizations', 'requests', qs.toString()],
    queryFn: () => getJson(`/api/realizations/requests?${qs}`),
    staleTime: 60_000,
  });

  const items = q.data?.items ?? [];
  const sorted = useMemo(() => sortRows(items, sort, (r, k) => (k === 'buyer' ? humanName(r.buyer) : k === 'manager' ? humanName(r.manager) : r[k]) as number | string | null), [items, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const curPage = Math.min(Math.max(1, page), pages);
  const pageRows = sorted.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);
  const logistOpts = (q.data?.options.logists ?? []).filter(l => !regionOk || l.region === regionOk);
  const activeFilters = [regionOk, logist, status].filter(Boolean).length;
  const cardHref = (id: string) => { const n = new URLSearchParams(sp.toString()); n.set('request', id); return `${pathname}?${n}`; };

  function resetFilters() { patch({ region: null, logist: null, status: null, page: null }); }
  function showPrevMonth() {
    const d = new Date(period.from); const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const last = new Date(d.getFullYear(), d.getMonth(), 0, 23, 59, 59, 999);
    setPeriod({ from: first, to: last });
  }
  function exportCsv() {
    const head = ['Номер', 'Дата', 'Статус', 'Покупатель', 'Менеджер', 'Логист', 'Плановая отгрузка', 'Продажа без НДС', 'Закупка без НДС', 'Маржа без НДС'];
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = sorted.map(r => [r.number, fmtDate(r.docDate), r.status, humanName(r.buyer) ?? 'Без покупателя', humanName(r.manager) ?? '', r.logist ?? '',
      fmtDate(r.shipmentDate), r.salesNv ?? '', r.purchasesN ? r.purchNv ?? '' : '', r.broken ? 'закупка задвоена' : r.marginNv ?? ''].map(esc).join(';'));
    const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `zayavki-${from}-${to}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const filters = (
    <>
      <select aria-label="Регион" value={regionOk} onChange={e => patch({ region: e.target.value || null, logist: null, page: null })} className={selectCls}>
        <option value="">Все регионы</option>
        {REGIONS.map(r => <option key={r} value={r}>{REGION_LABEL[r]}</option>)}
      </select>
      <select aria-label="Логист" value={logist} onChange={e => patch({ logist: e.target.value || null, page: null })} className={`${selectCls} sm:max-w-[240px]`}>
        <option value="">Все логисты</option>
        {logistOpts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        <option value="__none">Логист не указан</option>
      </select>
      <select aria-label="Статус" value={status} onChange={e => patch({ status: e.target.value || null, page: null })} className={`${selectCls} sm:max-w-[220px]`}>
        <option value="">Все статусы</option>
        <optgroup label="Группы">
          <option value="grp:shipped">Отгружено (все)</option>
          <option value="grp:cancelled">Отмена (все)</option>
          <option value="grp:in_work">В работе (все)</option>
        </optgroup>
        <optgroup label="Статусы 1С">
          {(q.data?.options.statuses ?? []).map(s => <option key={s} value={s}>{s}</option>)}
        </optgroup>
      </select>
      {activeFilters > 0 && (
        <button type="button" onClick={resetFilters} className="focus-ring h-9 rounded-lg px-2 text-[13px] font-medium text-[var(--brand)] hover:underline">Сбросить фильтры</button>
      )}
    </>
  );

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[var(--color-bg)]">
      <div className="flex flex-col gap-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Заявки</h1>
          <span className="text-[13px] text-[var(--color-text-muted)]">заявки и работа логистов по данным 1С, суммы без НДС</span>
        </div>

        {/* Тулбар: одна строка на десктопе (как FilterBar «Продаж»), на телефоне —
            [период][Фильтры N], фильтры раскрываются под ним (находка 19). */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2">
          <PeriodRangeControls period={period} comparison={recomputeComparison(period)} showComparison={false}
            onPeriodChange={p => { patch({ page: null, from: null, to: null }); setPeriod(p); }} onComparisonChange={() => {}} />
          <div className="hidden sm:flex flex-wrap items-center gap-2">{filters}</div>
          <button type="button" onClick={() => setFiltersOpen(o => !o)} aria-expanded={filtersOpen}
            className="focus-ring sm:hidden inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[13px] font-medium text-[var(--color-text)]">
            <SlidersHorizontal size={16} aria-hidden />Фильтры{activeFilters ? <span className="rounded-full bg-[var(--color-accent)] px-1.5 text-xs text-[var(--color-text-inverse)]">{activeFilters}</span> : null}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={exportCsv} disabled={!sorted.length} title="Скачать список (CSV для Excel)"
              className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[13px] font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
              <Download size={16} aria-hidden /><span className="hidden sm:inline">Скачать</span>
            </button>
            <button type="button" onClick={() => q.refetch()} title="Обновить" aria-label="Обновить"
              className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
              <RefreshCw size={16} className={q.isFetching ? 'animate-spin' : ''} aria-hidden />
            </button>
          </div>
          {filtersOpen && <div className="sm:hidden grid w-full grid-cols-1 gap-2">{filters}</div>}
        </div>

        {/* Оговорки данных — один баннер (находка 14). */}
        <div role="status" className="flex items-start gap-2 rounded-lg border border-[var(--color-accent)]/25 bg-[var(--blue-50)] px-3 py-2 text-[13px] text-[var(--color-text)]">
          <Info size={16} className="mt-px shrink-0 text-[var(--color-accent)]" aria-hidden />
          <span>Период — по плановой дате отгрузки. Маржа предварительная — методика ещё не согласована; заявки с задвоенной в 1С суммой закупки в маржу не входят. Данные обновляются раз в 5 минут.</span>
        </div>

        {q.isLoading && <div className="flex items-center gap-2 py-10 justify-center text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Загружаем заявки…</div>}
        {q.error && <div className="rounded-lg border border-[var(--danger-text)]/30 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]">{(q.error as Error).message}</div>}
        {q.data && (items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-12 text-center">
            <div className="text-[15px] font-semibold text-[var(--color-text)]">Заявок нет</div>
            <div className="max-w-md text-[13px] text-[var(--color-text-muted)]">
              {activeFilters ? 'За выбранный период с этими фильтрами заявок не найдено.' : 'За выбранный период заявок с плановой отгрузкой нет.'}
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {activeFilters > 0 && <button type="button" onClick={resetFilters} className="focus-ring h-9 rounded-lg bg-[var(--color-accent)] px-3 text-[13px] font-medium text-[var(--color-text-inverse)]">Сбросить фильтры</button>}
              <button type="button" onClick={showPrevMonth} className="focus-ring h-9 rounded-lg border border-[var(--color-border)] px-3 text-[13px] font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">Показать прошлый месяц</button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="Заявок" value={fmtInt(q.data.total)} />
              <Kpi label="Сумма продажи" value={fmtMlnRub(q.data.totals.salesNv)} hint="без НДС, все заявки выборки" />
              <Kpi label="Маржа" value={fmtMlnRub(q.data.totals.marginNv)} hint="без НДС, предварительно" />
              <Kpi label="Маржа, %" value={fmtPct(q.data.totals.mSalesNv ? (100 * q.data.totals.marginNv) / q.data.totals.mSalesNv : null)} hint="по заявкам с закупками" />
            </div>
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
              <div className="scroll-x max-h-[70dvh] overflow-auto">
                <table className="w-full border-collapse text-[13px] text-[var(--color-text)]">
                  <thead>
                    <tr>
                      {([['number', 'Номер', 'left'], ['docDate', 'Дата', 'left'], ['status', 'Статус', 'left'], ['buyer', 'Покупатель', 'left'],
                        ['manager', 'Менеджер', 'left'], ['logist', 'Логист', 'left'], ['shipmentDate', 'Плановая отгрузка', 'left'],
                        ['salesNv', 'Продажа, ₽', 'right'], ['purchNv', 'Закупка, ₽', 'right'], ['marginNv', 'Маржа, ₽ (предв.)', 'right']] as [ReqKey, string, 'left' | 'right'][])
                        .map(([k, label, align], i) => (
                          <SortableTh key={k} label={label} align={align} sticky={i === 0} active={sort.key === k} dir={sort.dir} onClick={() => { toggle(k); setPage(1); }} />
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(r => (
                      <tr key={r.id} className="report-row focus-ring cursor-pointer" onClick={() => setCardId(r.id)} tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter') setCardId(r.id); }}>
                        <td className={`${tdCls} sticky left-0 z-10 bg-[var(--color-bg-surface)]`}>
                          <Link href={cardHref(r.id)} scroll={false} onClick={e => { e.preventDefault(); e.stopPropagation(); setCardId(r.id); }}
                            className="focus-ring rounded-sm font-semibold text-[var(--brand)] hover:underline tabular-nums">{r.number}</Link>
                        </td>
                        <td className={`${tdCls} tabular-nums`}>{fmtDate(r.docDate)}</td>
                        <td className={tdCls}><StatusBadge status={r.status} grp={r.grp} /></td>
                        <td className={`${tdCls} max-w-[220px] truncate`} title={r.buyer ?? ''}>{humanName(r.buyer) ?? <span className="text-[var(--color-text-muted)]">Без покупателя</span>}</td>
                        <td className={`${tdCls} max-w-[180px] truncate`} title={r.manager ?? ''}>{humanName(r.manager) ?? DASH}</td>
                        <td className={`${tdCls} max-w-[200px] truncate`} title={r.logist ?? ''}>
                          {r.logistId ? (
                            <button type="button" onClick={e => { e.stopPropagation(); patch({ logist: r.logistId, page: null }); }} title="Показать заявки этого логиста"
                              className="focus-ring rounded-sm hover:text-[var(--brand)] hover:underline">{r.logist ?? DASH}</button>
                          ) : <span className="text-[var(--color-text-muted)]">не указан</span>}
                        </td>
                        <td className={`${tdCls} tabular-nums`}>{fmtDate(r.shipmentDate)}</td>
                        <td className={`${tdCls} ${numCls}`}>{fmtRub(r.salesNv)}</td>
                        <td className={`${tdCls} ${numCls}`}>{r.purchasesN ? fmtRub(r.purchNv) : DASH}</td>
                        <td className={`${tdCls} ${numCls}`}>
                          <MarginCell v={r.marginNv} sales={r.salesNv} broken={r.broken} noPurch={!r.purchasesN} cancelled={r.grp === 'cancelled'} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold">
                      <td className={`${tdCls} sticky left-0 bottom-0 z-20 bg-[var(--blue-50)] border-l-[3px] border-l-[var(--color-accent)]`}>Итого</td>
                      <td colSpan={6} className={`${tdCls} sticky bottom-0 bg-[var(--blue-50)] text-[var(--color-text-muted)] font-normal`}>{fmtInt(q.data.total)} заявок</td>
                      <td className={`${tdCls} ${numCls} sticky bottom-0 bg-[var(--blue-50)]`}>{fmtRub(q.data.totals.salesNv)}</td>
                      <td className={`${tdCls} ${numCls} sticky bottom-0 bg-[var(--blue-50)]`}>{fmtRub(q.data.totals.purchNv)}</td>
                      <td className={`${tdCls} ${numCls} sticky bottom-0 bg-[var(--blue-50)]`}>{fmtRub(q.data.totals.marginNv)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-3 py-2 text-[13px] text-[var(--color-text-muted)]">
                <span>Показаны {fmtInt((curPage - 1) * PAGE_SIZE + 1)}–{fmtInt(Math.min(curPage * PAGE_SIZE, sorted.length))} из {fmtInt(q.data.total)}{q.data.truncated ? ' (выборка ограничена 5 000 строк — сузьте фильтры)' : ''}</span>
                {pages > 1 && (
                  <nav className="ml-auto flex items-center gap-1" aria-label="Страницы">
                    <button type="button" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)} aria-label="Предыдущая страница"
                      className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text)] disabled:opacity-40"><ChevronLeft size={16} /></button>
                    <span className="px-2 tabular-nums text-[var(--color-text)]">{curPage} из {pages}</span>
                    <button type="button" disabled={curPage >= pages} onClick={() => setPage(curPage + 1)} aria-label="Следующая страница"
                      className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text)] disabled:opacity-40"><ChevronRight size={16} /></button>
                  </nav>
                )}
              </div>
            </div>
          </>
        ))}
      </div>

      {cardId && <RequestCardPanel key={cardId} id={cardId} onClose={() => setCardId(null)}
        onPickLogist={id => { patch({ logist: id, region: null, page: null, request: null }); }} />}
    </div>
  );
}
