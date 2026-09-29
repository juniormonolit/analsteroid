'use client';
// «Продажи → Реализация» (задача #8034, просьба Сергея 29.09). Отчёты по
// логистам на данных базы Диспетчера (схема sd — зеркало 1С), этап 1:
//   • «Заявки» — список sd.requests с фильтрами и карточкой заявки;
//   • «Сводка по логистам» — метрики М1–М9, М11, М12 из предложения Софьи;
//   • «Регионы» — та же сводка по регионам (СПБ/МСК/КРД).
// Доступ — только роль «Администратор» (гейт в layout и во всех API).
// Маржа — без НДС, методика ещё не согласована: подписана «предварительно».

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, AlertTriangle, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { RequestCardModal } from './RequestCardModal';
import { DASH, fmt1, fmtDate, fmtInt, fmtMln, fmtPct, fmtRub } from './format';
import type { SummaryRow, StatusTimeRow } from '@/lib/realizations/metrics';
import { REGIONS, REGION_LABEL, type Region } from '@/lib/realizations/region';
import { defaultPeriod } from '@/lib/realizations/filters';

type Tab = 'requests' | 'logists' | 'regions';
const TABS: { key: Tab; label: string }[] = [
  { key: 'requests', label: 'Заявки' },
  { key: 'logists', label: 'Сводка по логистам' },
  { key: 'regions', label: 'Регионы' },
];

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
interface OrphanRow { creator: string; n: number; amountVat: number; nAccountable: number }
interface SummaryResp {
  today: string; rows: SummaryRow[]; total: SummaryRow; statusTimes: StatusTimeRow[]; orphans: OrphanRow[];
  options: { logists: LogistOpt[] };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`);
  return body as T;
}

// ── Общие стили (как в остальных экранах Монолитики) ─────────────────────────
const inputCls = 'min-h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-border-focus)]';
const thCls = 'sticky top-0 z-10 bg-[var(--color-table-header)] border-b border-[var(--color-border)] px-2 py-1.5 text-[11px] font-semibold text-[var(--color-text-muted)] whitespace-nowrap select-none';
const tdCls = 'border-b border-[var(--color-table-row-border,var(--color-border))] px-2 py-1.5 whitespace-nowrap';
const numCls = 'text-right tabular-nums';

function presetPeriods(today: string) {
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  return [
    { key: '30', label: '30 дней', ...defaultPeriod() },
    { key: 'cur', label: 'Текущий месяц', from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last(y, m))}` },
    { key: 'prev', label: 'Прошлый месяц', from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(last(py, pm))}` },
  ];
}

function StatusBadge({ status, grp }: { status: string; grp: RequestItem['grp'] }) {
  const cls = grp === 'shipped'
    ? 'bg-[var(--color-positive)]/12 text-[var(--color-positive)] border-[var(--color-positive)]/30'
    : grp === 'cancelled'
      ? 'bg-[var(--color-negative)]/10 text-[var(--color-negative)] border-[var(--color-negative)]/30'
      : 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] border-[var(--color-accent)]/30';
  return <span className={`inline-block max-w-[220px] truncate rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`} title={status}>{status}</span>;
}

function MarginCell({ v, sales, broken, noPurch, cancelled }: { v: number | null; sales?: number | null; broken?: boolean; noPurch?: boolean; cancelled?: boolean }) {
  if (cancelled) return <span className="text-[var(--color-text-muted)]">{DASH}</span>;
  if (broken) return <span className="inline-flex items-center gap-1 text-[var(--color-warning)]" title="Есть приобретение с integrity_ok = false (сумма задвоена) — заявка исключена из маржи"><AlertTriangle size={12} />искл.</span>;
  if (noPurch) return <span className="text-[var(--color-text-muted)]" title="Нет приобретений — себестоимости в базе нет">нет закупки</span>;
  if (v === null) return <span className="text-[var(--color-text-muted)]">{DASH}</span>;
  const pct = sales ? (100 * v) / sales : null;
  return (
    <span className={v < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}>
      {fmtRub(v)}{pct !== null && <span className="ml-1 text-[10px] opacity-80">{fmtPct(pct)}</span>}
    </span>
  );
}

// ── Сортировка таблиц (клик по заголовку — правило Серёги) ───────────────────
type SortState<K extends string> = { key: K; dir: 'asc' | 'desc' };
function useSort<T, K extends string>(rows: T[], init: SortState<K>, get: (r: T, k: K) => number | string | null) {
  const [sort, setSort] = useState<SortState<K>>(init);
  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const va = get(a, sort.key), vb = get(b, sort.key);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ru');
      return sort.dir === 'asc' ? c : -c;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const toggle = (key: K) => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  return { sorted, sort, toggle };
}
function SortTh<K extends string>({ k, label, sort, toggle, right, title }: { k: K; label: string; sort: SortState<K>; toggle: (k: K) => void; right?: boolean; title?: string }) {
  const active = sort.key === k;
  return (
    <th className={`${thCls} ${right ? 'text-right' : 'text-left'} cursor-pointer hover:text-[var(--color-text)]`} onClick={() => toggle(k)} title={title}>
      <span className={`inline-flex items-center gap-0.5 ${right ? 'flex-row-reverse' : ''}`}>
        {label}
        {active ? (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : <span className="w-[11px]" />}
      </span>
    </th>
  );
}

function Loading() {
  return <div className="flex items-center gap-2 py-10 justify-center text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Считаем по базе Диспетчера…</div>;
}
function ErrorBox({ msg }: { msg: string }) {
  return <div className="rounded-lg border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 px-3 py-2 text-sm text-[var(--color-negative)]">{msg}</div>;
}
function Empty({ text }: { text: string }) {
  return <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">{text}</div>;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5">
      <div className="text-[11px] text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--color-text)]">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)] truncate" title={hint}>{hint}</div>}
    </div>
  );
}

// ── Страница ─────────────────────────────────────────────────────────────────
export function RealizationsPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const def = defaultPeriod();
  const tab = (TABS.find(t => t.key === sp.get('tab'))?.key ?? 'requests') as Tab;
  const from = sp.get('from') || def.from;
  const to = sp.get('to') || def.to;
  const region = (REGIONS as string[]).includes(sp.get('region') ?? '') ? (sp.get('region') as Region) : '';
  const logist = sp.get('logist') ?? '';
  const status = sp.get('status') ?? '';
  const [cardId, setCardId] = useState<string | null>(null);

  function setParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    router.replace(`/realizations?${next.toString()}`, { scroll: false });
  }

  const qs = new URLSearchParams({ from, to, ...(region ? { region } : {}), ...(logist ? { logist } : {}) });
  const reqQs = new URLSearchParams(qs); if (status) reqQs.set('status', status);

  const requestsQ = useQuery<RequestsResp>({
    queryKey: ['realizations', 'requests', reqQs.toString()],
    queryFn: () => getJson(`/api/realizations/requests?${reqQs}`),
    enabled: tab === 'requests', staleTime: 60_000,
  });
  const by = tab === 'regions' ? 'region' : 'logist';
  const summaryQ = useQuery<SummaryResp>({
    queryKey: ['realizations', 'summary', by, qs.toString()],
    queryFn: () => getJson(`/api/realizations/summary?${qs}&by=${by}`),
    enabled: tab !== 'requests', staleTime: 60_000,
  });

  const logistOpts = (tab === 'requests' ? requestsQ.data?.options.logists : summaryQ.data?.options.logists) ?? [];
  const logistsInRegion = logistOpts.filter(l => !region || l.region === region);
  const statuses = requestsQ.data?.options.statuses ?? [];
  const presets = presetPeriods(new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10));

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[var(--color-bg)]">
      <div className="flex flex-col gap-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-bold text-[var(--color-text)]">Заявки и логисты</h1>
          <span className="text-xs text-[var(--color-text-muted)]">заявки и метрики логистов · база Диспетчера (зеркало 1С) · суммы без НДС</span>
        </div>

        {/* Вкладки — flex-wrap (3 вкладки, без горизонтального скролла, CLAUDE.md п.12) */}
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {TABS.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              onClick={() => setParams({ tab: t.key === 'requests' ? null : t.key })}
              className={`min-h-9 rounded-full border px-3.5 text-xs font-semibold transition-colors ${tab === t.key
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Фильтры */}
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:flex sm:flex-wrap sm:items-end">
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
            Плановая отгрузка с
            <input type="date" value={from} max={to} onChange={e => e.target.value && setParams({ from: e.target.value })} className={inputCls} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
            по
            <input type="date" value={to} min={from} onChange={e => e.target.value && setParams({ to: e.target.value })} className={inputCls} />
          </label>
          <div className="col-span-2 flex flex-wrap gap-1 sm:col-span-1 sm:self-end">
            {presets.map(p => (
              <button key={p.key} type="button" onClick={() => setParams({ from: p.from, to: p.to })}
                className={`min-h-9 rounded-lg border px-2.5 text-[11px] font-medium ${from === p.from && to === p.to
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                {p.label}
              </button>
            ))}
          </div>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
            Регион
            <select value={region} onChange={e => setParams({ region: e.target.value || null, logist: null })} className={inputCls}>
              <option value="">Все регионы</option>
              {REGIONS.map(r => <option key={r} value={r}>{REGION_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--color-text-muted)] sm:min-w-[220px]">
            Логист
            <select value={logist} onChange={e => setParams({ logist: e.target.value || null })} className={inputCls}>
              <option value="">Все логисты</option>
              {logistsInRegion.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              <option value="__none">Логист не указан</option>
            </select>
          </label>
          {tab === 'requests' && (
            <label className="col-span-2 flex min-w-0 flex-col gap-1 text-[11px] text-[var(--color-text-muted)] sm:col-span-1 sm:min-w-[200px]">
              Статус
              <select value={status} onChange={e => setParams({ status: e.target.value || null })} className={inputCls}>
                <option value="">Все статусы</option>
                <optgroup label="Группы">
                  <option value="grp:shipped">Отгружено (все)</option>
                  <option value="grp:cancelled">Отмена (все)</option>
                  <option value="grp:in_work">В работе (все)</option>
                </optgroup>
                <optgroup label="Статусы 1С">
                  {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                </optgroup>
              </select>
            </label>
          )}
          {(region || logist || status) && (
            <button type="button" onClick={() => setParams({ region: null, logist: null, status: null })}
              className="col-span-2 min-h-9 rounded-lg px-2 text-[11px] font-medium text-[var(--color-accent)] hover:underline sm:col-span-1 sm:self-end">
              Сбросить фильтры
            </button>
          )}
        </div>

        {tab === 'requests' && <RequestsTab q={requestsQ} onOpen={setCardId} />}
        {tab !== 'requests' && (
          <SummaryTab q={summaryQ} by={by}
            onPick={row => by === 'logist'
              ? setParams({ tab: null, logist: row.key === '__total' ? null : row.key })
              : setParams({ tab: 'logists', region: row.key === '__total' ? null : row.key, logist: null })} />
        )}

        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--color-text-muted)]">
          <Info size={12} className="mt-px shrink-0" />
          <span>
            Период — по плановой дате отгрузки. Дубли заявок (один номер у одного покупателя) схлопнуты до последней копии.
            Маржа — без НДС, предварительно: методика ещё не согласована. Приобретения с задвоенной суммой (integrity_ok = false)
            исключают заявку из маржи и помечены «искл.». Данные обновляются раз в 5 минут.
          </span>
        </p>
      </div>

      {cardId && <RequestCardModal id={cardId} onClose={() => setCardId(null)} />}
    </div>
  );
}

// ── Вкладка «Заявки» ─────────────────────────────────────────────────────────
type ReqKey = 'number' | 'docDate' | 'status' | 'buyer' | 'manager' | 'logist' | 'shipmentDate' | 'salesNv' | 'purchNv' | 'marginNv';
function RequestsTab({ q, onOpen }: { q: ReturnType<typeof useQuery<RequestsResp>>; onOpen: (id: string) => void }) {
  const items = q.data?.items ?? [];
  const { sorted, sort, toggle } = useSort<RequestItem, ReqKey>(items, { key: 'shipmentDate', dir: 'desc' }, (r, k) => r[k] as number | string | null);
  const [limit, setLimit] = useState(300);
  useEffect(() => setLimit(300), [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox msg={(q.error as Error).message} />;
  if (!q.data) return null;
  const t = q.data.totals;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="Заявок" value={fmtInt(q.data.total)} />
        <Kpi label="Сумма продажи" value={`${fmtMln(t.salesNv)} млн`} hint="без НДС, все заявки выборки" />
        <Kpi label="Маржа (база)" value={`${fmtMln(t.marginNv)} млн`} hint="без НДС, предварительно" />
        <Kpi label="Маржа, %" value={fmtPct(t.mSalesNv ? (100 * t.marginNv) / t.mSalesNv : null)} hint="заявки с закупками, без искл." />
      </div>
      {items.length === 0 ? <Empty text="За выбранный период и фильтры заявок нет" /> : (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <div className="scroll-x max-h-[70dvh] overflow-y-auto">
            <table className="w-full border-collapse text-xs text-[var(--color-text)]">
              <thead>
                <tr>
                  <SortTh k="number" label="Номер" sort={sort} toggle={toggle} />
                  <SortTh k="docDate" label="Дата" sort={sort} toggle={toggle} />
                  <SortTh k="status" label="Статус" sort={sort} toggle={toggle} />
                  <SortTh k="buyer" label="Покупатель" sort={sort} toggle={toggle} />
                  <SortTh k="manager" label="Менеджер" sort={sort} toggle={toggle} />
                  <SortTh k="logist" label="Логист" sort={sort} toggle={toggle} />
                  <SortTh k="shipmentDate" label="План. отгрузка" sort={sort} toggle={toggle} />
                  <SortTh k="salesNv" label="Продажа" sort={sort} toggle={toggle} right title="Сумма строк заявки без НДС" />
                  <SortTh k="purchNv" label="Закупка" sort={sort} toggle={toggle} right title="Сумма приобретений без НДС" />
                  <SortTh k="marginNv" label="Маржа" sort={sort} toggle={toggle} right title="Без НДС, предварительно" />
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, limit).map(r => (
                  <tr key={r.id} className="report-row cursor-pointer" onClick={() => onOpen(r.id)} tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') onOpen(r.id); }}>
                    <td className={`${tdCls} font-semibold text-[var(--color-accent)]`}>{r.number}</td>
                    <td className={tdCls}>{fmtDate(r.docDate)}</td>
                    <td className={tdCls}><StatusBadge status={r.status} grp={r.grp} /></td>
                    <td className={`${tdCls} max-w-[220px] truncate`} title={r.buyer ?? ''}>{r.buyer ?? DASH}</td>
                    <td className={`${tdCls} max-w-[180px] truncate`} title={r.manager ?? ''}>{r.manager ?? DASH}</td>
                    <td className={`${tdCls} max-w-[200px] truncate`} title={r.logist ?? ''}>{r.logist ?? DASH}</td>
                    <td className={tdCls}>{fmtDate(r.shipmentDate)}</td>
                    <td className={`${tdCls} ${numCls}`}>{fmtRub(r.salesNv)}</td>
                    <td className={`${tdCls} ${numCls}`}>{r.purchasesN ? fmtRub(r.purchNv) : DASH}</td>
                    <td className={`${tdCls} ${numCls}`}>
                      <MarginCell v={r.marginNv} sales={r.salesNv} broken={r.broken} noPurch={!r.purchasesN} cancelled={r.grp === 'cancelled'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            <span>Показано {fmtInt(Math.min(limit, sorted.length))} из {fmtInt(q.data.total)}{q.data.truncated ? ' (выборка ограничена 5 000 строк — сузьте фильтры)' : ''}</span>
            {sorted.length > limit && (
              <button type="button" onClick={() => setLimit(l => l + 500)} className="min-h-9 rounded-lg border border-[var(--color-border)] px-3 font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                Показать ещё
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── Вкладки «Сводка по логистам» и «Регионы» ────────────────────────────────
type SumKey = 'label' | 'total' | 'shipped' | 'cancelled' | 'inWork' | 'cancelPct' | 'onTimePct' | 'cycleDaysMed' | 'reactHoursMed'
  | 'fixPct' | 'shippedNoPurchase' | 'salesNv' | 'avgCheckNv' | 'marginBaseN' | 'exclBroken' | 'marginNv' | 'marginPct'
  | 'overdue' | 'overdue30' | 'dSale' | 'dCost' | 'dCostToSalePct';
const SUM_COLS: { k: SumKey; label: string; title: string; fmt: (r: SummaryRow) => React.ReactNode }[] = [
  { k: 'total', label: 'Заявок', title: 'М1: заявок с плановой отгрузкой в периоде', fmt: r => fmtInt(r.total) },
  { k: 'shipped', label: 'Отгр.', title: 'М1: отгружено / выполнено', fmt: r => fmtInt(r.shipped) },
  { k: 'cancelled', label: 'Отмена', title: 'М1: отменено', fmt: r => fmtInt(r.cancelled) },
  { k: 'inWork', label: 'В работе', title: 'М1: ещё в работе', fmt: r => fmtInt(r.inWork) },
  { k: 'cancelPct', label: 'Отмен %', title: 'М1: доля отмен', fmt: r => fmtPct(r.cancelPct) },
  { k: 'onTimePct', label: 'В срок %', title: 'М2: первое «Отгружено» (МСК) не позже плановой даты; знаменатель — отгруженные с событием в истории', fmt: r => fmtPct(r.onTimePct) },
  { k: 'cycleDaysMed', label: 'Цикл, дн', title: 'М3: медиана «Новая заявка → Отгружено», дни', fmt: r => fmt1(r.cycleDaysMed) },
  { k: 'reactHoursMed', label: 'Реакция, ч', title: 'М4: медиана «Новая заявка → Взята в работу», часы', fmt: r => fmt1(r.reactHoursMed) },
  { k: 'overdue', label: 'Просрочено', title: 'М5: сейчас (все даты): плановая отгрузка прошла, заявка в работе', fmt: r => fmtInt(r.overdue) },
  { k: 'overdue30', label: '>30 дн', title: 'М5: из просроченных — старше 30 дней', fmt: r => fmtInt(r.overdue30) },
  { k: 'fixPct', label: 'Правки %', title: 'М6: доля отгруженных, возвращавшихся в «Отгружено, требует правки логиста»', fmt: r => fmtPct(r.fixPct) },
  { k: 'shippedNoPurchase', label: 'Без приобр.', title: 'М7: отгружено без единого приобретения', fmt: r => fmtInt(r.shippedNoPurchase) },
  { k: 'salesNv', label: 'Выручка, млн', title: 'М8: выручка отгруженного, без НДС', fmt: r => fmtMln(r.salesNv) },
  { k: 'avgCheckNv', label: 'Ср. чек', title: 'М8: выручка / число отгруженных, без НДС', fmt: r => fmtRub(r.avgCheckNv) },
  { k: 'marginBaseN', label: 'База маржи', title: 'М9: отгруженные с приобретениями, без integrity_ok=false', fmt: r => fmtInt(r.marginBaseN) },
  { k: 'exclBroken', label: 'Искл.', title: 'М9: отгруженные, исключённые из маржи (задвоенные приобретения)', fmt: r => r.exclBroken ? <span className="text-[var(--color-warning)]">{fmtInt(r.exclBroken)}</span> : '0' },
  { k: 'marginNv', label: 'Маржа, млн', title: 'М9: Σ продажи − Σ закупки по базе, без НДС, предварительно', fmt: r => <span className={(r.marginNv ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''}>{fmtMln(r.marginNv)}</span> },
  { k: 'marginPct', label: 'Маржа %', title: 'М9: маржа / продажа базы, без НДС, предварительно', fmt: r => <span className={(r.marginPct ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''}>{fmtPct(r.marginPct)}</span> },
  { k: 'dSale', label: 'Доставка: выручка, млн', title: 'М11: строки заявки с номенклатурой «…доставк…», без НДС', fmt: r => fmtMln(r.dSale || null) },
  { k: 'dCost', label: 'Доставка: расход, млн', title: 'М11: строки приобретений «Доставка» / «Доставка для логистов», без НДС', fmt: r => fmtMln(r.dCost || null) },
  { k: 'dCostToSalePct', label: 'Расход / выручка', title: 'М11: расход на доставку к выручке за доставку', fmt: r => fmtPct(r.dCostToSalePct) },
];

function SummaryTab({ q, by, onPick }: { q: ReturnType<typeof useQuery<SummaryResp>>; by: 'logist' | 'region'; onPick: (r: SummaryRow) => void }) {
  const rows = q.data?.rows ?? [];
  const { sorted, sort, toggle } = useSort<SummaryRow, SumKey>(rows, { key: 'total', dir: 'desc' }, (r, k) => r[k] as number | string | null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox msg={(q.error as Error).message} />;
  if (!q.data) return null;
  const t = q.data.total;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Заявок" value={fmtInt(t.total)} hint={`отгр. ${fmtInt(t.shipped)} · отмена ${fmtInt(t.cancelled)} · в работе ${fmtInt(t.inWork)}`} />
        <Kpi label="В срок" value={fmtPct(t.onTimePct)} hint={`из ${fmtInt(t.shipWithHist)} отгруженных с историей`} />
        <Kpi label="Просрочено сейчас" value={fmtInt(t.overdue)} hint={`старше 30 дн. — ${fmtInt(t.overdue30)}`} />
        <Kpi label="Выручка отгруженного" value={`${fmtMln(t.salesNv)} млн`} hint={`ср. чек ${fmtRub(t.avgCheckNv)}`} />
        <Kpi label="Маржа заявок" value={fmtPct(t.marginPct)} hint={`${fmtMln(t.marginNv)} млн · без НДС, предварительно`} />
        <Kpi label="Доставка: расход / выручка" value={fmtPct(t.dCostToSalePct)} hint={`${fmtMln(t.dCost)} / ${fmtMln(t.dSale)} млн`} />
      </div>

      {rows.length === 0 ? <Empty text="За выбранный период и фильтры заявок нет" /> : (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <div className="scroll-x max-h-[70dvh] overflow-y-auto">
            <table className="w-full border-collapse text-xs text-[var(--color-text)]">
              <thead>
                <tr>
                  <SortTh k="label" label={by === 'logist' ? 'Логист' : 'Регион'} sort={sort} toggle={toggle} />
                  {by === 'logist' && <th className={`${thCls} text-left`}>Регион</th>}
                  {SUM_COLS.map(c => <SortTh key={c.k} k={c.k} label={c.label} title={c.title} sort={sort} toggle={toggle} right />)}
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => (
                  <tr key={r.key} className="report-row cursor-pointer" onClick={() => onPick(r)} tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') onPick(r); }}
                    title={by === 'logist' ? 'Открыть заявки логиста' : 'Логисты региона'}>
                    <td className={`${tdCls} max-w-[260px] truncate font-medium`}>{by === 'region' ? REGION_LABEL[r.key as Region] ?? r.label : r.label}</td>
                    {by === 'logist' && <td className={`${tdCls} text-[var(--color-text-muted)]`}>{r.region ?? DASH}</td>}
                    {SUM_COLS.map(c => <td key={c.k} className={`${tdCls} ${numCls}`}>{c.fmt(r)}</td>)}
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className={`${tdCls} bg-[var(--color-totals-bg,var(--color-bg-hover))]`}>Итого</td>
                  {by === 'logist' && <td className={`${tdCls} bg-[var(--color-totals-bg,var(--color-bg-hover))]`} />}
                  {SUM_COLS.map(c => <td key={c.k} className={`${tdCls} ${numCls} bg-[var(--color-totals-bg,var(--color-bg-hover))]`}>{c.fmt(t)}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            Наведите на заголовок — формула метрики. Клик по строке — {by === 'logist' ? 'заявки логиста' : 'логисты региона'}.
            Просрочки (М5) — на сегодня, {fmtDate(q.data.today)}, по всем плановым датам.
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <h2 className="px-3 pt-3 text-sm font-semibold text-[var(--color-text)]">Время в статусах (М4)</h2>
          <p className="px-3 pb-2 text-[11px] text-[var(--color-text-muted)]">От записи статуса до следующей записи истории; текущий статус не входит; статусы с &lt;20 интервалами скрыты.</p>
          {q.data.statusTimes.length === 0 ? <Empty text="Нет истории статусов" /> : (
            <div className="scroll-x">
              <table className="w-full border-collapse text-xs text-[var(--color-text)]">
                <thead><tr>
                  <th className={`${thCls} text-left`}>Статус</th>
                  <th className={`${thCls} text-right`}>Интервалов</th>
                  <th className={`${thCls} text-right`}>Медиана, ч</th>
                  <th className={`${thCls} text-right`}>90-й процентиль, ч</th>
                </tr></thead>
                <tbody>{q.data.statusTimes.map(s => (
                  <tr key={s.status} className="report-row">
                    <td className={tdCls}>{s.status}</td>
                    <td className={`${tdCls} ${numCls}`}>{fmtInt(s.n)}</td>
                    <td className={`${tdCls} ${numCls}`}>{fmt1(s.medianH)}</td>
                    <td className={`${tdCls} ${numCls}`}>{fmt1(s.p90H)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
        <section className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <h2 className="px-3 pt-3 text-sm font-semibold text-[var(--color-text)]">Закупки без привязки к заявке (М12)</h2>
          <p className="px-3 pb-2 text-[11px] text-[var(--color-text-muted)]">Приобретения с пустой заявкой за период (по дате документа), по автору. Не попадают в маржу; фильтры региона и логиста к ним не применяются.</p>
          {q.data.orphans.length === 0 ? <Empty text="Таких приобретений нет" /> : (
            <div className="scroll-x">
              <table className="w-full border-collapse text-xs text-[var(--color-text)]">
                <thead><tr>
                  <th className={`${thCls} text-left`}>Автор</th>
                  <th className={`${thCls} text-right`}>Документов</th>
                  <th className={`${thCls} text-right`}>Сумма, млн (с НДС)</th>
                  <th className={`${thCls} text-right`}>Из них подотчёт</th>
                </tr></thead>
                <tbody>{q.data.orphans.map(o => (
                  <tr key={o.creator} className="report-row">
                    <td className={tdCls}>{o.creator}</td>
                    <td className={`${tdCls} ${numCls}`}>{fmtInt(o.n)}</td>
                    <td className={`${tdCls} ${numCls}`}>{fmtMln(o.amountVat)}</td>
                    <td className={`${tdCls} ${numCls}`}>{fmtInt(o.nAccountable)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
