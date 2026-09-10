'use client';
// Экран диагностики, фаза 1 (ТЗ №1 §11): таблица менеджеров × узлы дерева с состояниями,
// прогноз плана и разрыв, раскрытие менеджера — все узлы с базами, интервалом, n, следом.
// Кнопки ручного пересчёта — пока движок не на планировщике.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Play, ChevronDown, ChevronRight, AlertTriangle, TrendingDown, TrendingUp, Minus, HelpCircle, ArrowUp, ArrowDown } from 'lucide-react';

interface NodeRow { nodeId: string; asOf: string; tickNo: number | null; value: number | null; n: number | null; ciLow: number | null; ciHigh: number | null; ewma: number | null; cusumNeg: number | null; baseOwn: number | null; basePeers: number | null; baseTarget: number | null; sigma: number | null; status: string; trace: Record<string, unknown> | null }
interface Mgr { bitrixId: number; name: string; branch: string; category: string; plan: number | null; nodes: NodeRow[] }
interface NodeMeta { id: string; name: string; node_kind: string; window_kind: string; controllable: string; higher_is_better: boolean; sort_order: number; description: string | null }
interface RunProgress { id: number; kind: string; status: 'running' | 'done' | 'error'; stage: string | null; total: number; done: number; summary: Record<string, unknown> | null; error: string | null; startedAt: string; finishedAt: string | null }
interface Diagnosis {
  id: number; bitrixId: number; managerName: string; nodeId: string; nodeName: string; leverId: string | null; leverName: string | null;
  gapValue: number | null; gapShare: number | null; score: number | null; mode: string; arm: string; tooLate: boolean; recipientRole: string | null;
  status: string; outcome: string | null; trace: Record<string, unknown> | null; openedAt: string; closedAt: string | null; feedbackN: number;
}
interface Overview { today: string; nodes: NodeMeta[]; managers: Mgr[]; refs: { what: string; n: number; at: string | null }[]; activeManagers: number }

const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';
const cardCls = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4';

const COMPACT_NODES = ['cr_deal_to_sale', 'cr_deal_to_priced', 'cr_priced_to_reservation', 'cr_reservation_to_sale', 'booking_call_rate_reserved', 'calls_touch_speed_median', 'price_speed_median_hours', 'calls_deals_no_call', 'zombie_share', 'calls_silence_deals', 'cross_sell_expected_share'];
// Статусы детектора человеческим языком (владелец: «что значит drift_down?»).
const STATUS_LABEL: Record<string, string> = { ok: 'норма', drift_down: 'просадка', drift_up: 'рост', insufficient_data: 'мало данных', no_plan: 'нет плана' };
const statusLabel = (st: string) => STATUS_LABEL[st] ?? st;
const SHORT: Record<string, string> = {
  cr_deal_to_sale: 'CR→продажа', cr_deal_to_priced: 'CR→цена', cr_priced_to_reservation: 'цена→бронь', cr_reservation_to_sale: 'бронь→продажа',
  booking_call_rate_reserved: 'прозвон броней', calls_touch_speed_median: '1-е касание, мин', price_speed_median_hours: 'до цены, ч',
  calls_deals_no_call: 'без звонка', zombie_share: 'зомби, %', calls_silence_deals: 'тишина, шт', cross_sell_expected_share: 'кросс-продажа',
};
// Деньги — в миллионах с одним знаком (владелец: «сокращай до миллионов»); меньше 100 тыс — в тысячах.
const fmtRub = (v: number | null) => {
  if (v === null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 100_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} млн ₽`;
  return `${Math.round(v / 1000).toLocaleString('ru-RU')} тыс ₽`;
};
const fmtV = (v: number | null, nodeId: string) => {
  if (v === null) return '—';
  if (nodeId.startsWith('cr_') || nodeId.includes('rate') || nodeId.includes('share') || nodeId.includes('no_call') || nodeId.includes('pct')) return `${v.toFixed(1)}%`;
  if (nodeId.includes('median') || nodeId.includes('avg')) return v.toFixed(1);
  return Math.round(v).toLocaleString('ru-RU');
};
// Значение узла в его единицах (единицы приходят в трассе диагноза).
const fmtUnit = (v: number | null | undefined, unit: string | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'pct': return `${v.toFixed(1)}%`;
    case 'min': return v >= 120 ? `${(v / 60).toFixed(1)} ч` : `${Math.round(v)} мин`;
    case 'hours': return `${v.toFixed(1)} ч`;
    case 'count': return `${Math.round(v)} шт`;
    case 'rub': return fmtRub(v);
    default: return v.toFixed(1);
  }
};
const STATUS_CLS: Record<string, string> = {
  drift_down: 'bg-[color-mix(in_srgb,var(--color-negative)_16%,transparent)] text-[var(--color-negative)]',
  drift_up: 'bg-[color-mix(in_srgb,var(--color-positive)_16%,transparent)] text-[var(--color-positive)]',
  insufficient_data: 'text-[var(--color-text-muted)] opacity-60',
  ok: 'text-[var(--color-text)]',
};

export function DiagnosticsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Overview>({ queryKey: ['diag-overview'], queryFn: () => fetch('/api/diag/overview').then(r => r.json()), refetchOnWindowFocus: false });
  // Прогоны — фоновые (diag_runs): POST стартует и отдаёт id, дальше опрашиваем прогресс.
  const [runId, setRunId] = useState<number | null>(null);
  const [runKind, setRunKind] = useState<'refs' | 'daily' | null>(null);
  const start = useMutation({
    mutationFn: async (step: 'refs' | 'daily') => {
      const res = await fetch(`/api/diag/run?step=${step}`, { method: 'POST' });
      const body = await res.json() as { id?: number; busy?: RunProgress; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return { step, id: body.id ?? body.busy?.id ?? null };
    },
    onSuccess: r => { setRunKind(r.step); setRunId(r.id); },
  });
  const { data: runData } = useQuery<{ run: RunProgress | null }>({
    queryKey: ['diag-run', runId], enabled: runId !== null,
    queryFn: () => fetch(`/api/diag/run?id=${runId}`).then(r => r.json()),
    refetchInterval: q => (q.state.data?.run && q.state.data.run.status === 'running' ? 1500 : false),
  });
  const runP = runData?.run ?? null;
  useEffect(() => { if (runP && runP.status !== 'running') void qc.invalidateQueries({ queryKey: ['diag-overview'] }); }, [runP?.status, qc]); // eslint-disable-line react-hooks/exhaustive-deps
  // При открытии — подхватить уже идущий прогон.
  useQuery<{ runs: RunProgress[] }>({
    queryKey: ['diag-runs-last'], refetchOnWindowFocus: false, staleTime: Infinity,
    queryFn: async () => { const b = await fetch('/api/diag/run').then(r => r.json()) as { runs: RunProgress[] }; const active = b.runs.find(r => r.status === 'running'); if (active && runId === null) { setRunId(active.id); setRunKind(active.kind as 'refs' | 'daily'); } return b; },
  });
  const running = !!runP && runP.status === 'running';
  const [branch, setBranch] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const nodeMeta = useMemo(() => new Map((data?.nodes ?? []).map(n => [n.id, n])), [data]);
  const branches = useMemo(() => [...new Set((data?.managers ?? []).map(m => m.branch))].sort(), [data]);
  // Сортировка по клику на заголовок (владелец 10.09); по умолчанию — разрыв к плану по убыванию.
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'gap', dir: 'desc' });
  const toggleSort = (key: string) => setSort(s => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));
  const sortValue = (m: Mgr, key: string): number | string | null => {
    const root = m.nodes.find(n => n.nodeId === 'plan_forecast_pct_month');
    if (key === 'name') return m.name;
    if (key === 'plan') return m.plan;
    if (key === 'pct') return root?.value ?? null;
    if (key === 'gap') return (root?.trace as { gapRub?: number } | null)?.gapRub ?? null;
    return m.nodes.find(n => n.nodeId === key)?.value ?? null;
  };
  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const list = (data?.managers ?? []).filter(m => (!branch || m.branch === branch) && (!qq || m.name.toLowerCase().includes(qq)));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      const va = sortValue(a, sort.key), vb = sortValue(b, sort.key);
      if (va === null && vb === null) return 0; if (va === null) return 1; if (vb === null) return -1; // пустые — всегда внизу
      if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb), 'ru') * dir;
      return (va - vb) * dir;
    });
  }, [data, branch, q, sort]);
  const Th = ({ k, children, align = 'right', title }: { k: string; children: React.ReactNode; align?: 'left' | 'right'; title?: string }) => (
    <th className={`px-2 py-2 text-${align} whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] ${sort.key === k ? 'text-[var(--color-accent)]' : ''}`} title={title} onClick={() => toggleSort(k)}>
      {children}{sort.key === k && (sort.dir === 'asc' ? <ArrowUp size={10} className="inline ml-0.5" /> : <ArrowDown size={10} className="inline ml-0.5" />)}
    </th>
  );
  const refAt = (what: string) => { const r = data?.refs.find(x => x.what === what); return r ? `${r.n} · ${r.at ? new Date(r.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—'}` : '—'; };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-3 sm:p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-[var(--color-text)]">Диагностика · менеджеры</h1>
          <p className="text-[12px] text-[var(--color-text-muted)]">
            Фаза 1: ряды по дереву показателей без отправок. Окно — последние закрытые сделки (настройки), базы — своё предыдущее окно и медиана пиров филиал×направление.
            Активных (с планом на месяц): {data?.activeManagers ?? '…'}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/settings/diagnostics/checks" className={btnCls}>Проверки данных</a>
          <button className={btnCls} disabled={running || start.isPending} onClick={() => start.mutate('refs')}><RefreshCw size={14} className={running && runKind === 'refs' ? 'animate-spin' : ''} /> Справочники (лаги, зомби, сезон)</button>
          <button className={btnPrimaryCls} disabled={running || start.isPending} onClick={() => start.mutate('daily')}><Play size={14} /> Пересчитать сегодня</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <Chip>лаги: {refAt('lags')}</Chip><Chip>зомби-пороги: {refAt('zombie')}</Chip><Chip>сезонность: {refAt('season')}</Chip><Chip>рядов сегодня: {refAt('series_today')}</Chip>
      </div>
      {start.isError && <div className={`${cardCls} text-sm text-[var(--color-negative)]`}><AlertTriangle size={14} className="inline mr-1" /> {(start.error as Error).message}</div>}
      {runP && (
        <div className={cardCls}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--color-text)]">
            <span className="font-semibold">{runP.kind === 'refs' ? 'Справочники' : 'Ежедневный расчёт'} · {runP.status === 'running' ? 'идёт' : runP.status === 'done' ? 'готово' : 'ошибка'}</span>
            <span className="text-[12px] text-[var(--color-text-muted)]">{runP.stage ?? ''}{runP.total ? ` · ${runP.done}/${runP.total}` : ''} · старт {new Date(runP.startedAt).toLocaleTimeString('ru-RU')}{runP.finishedAt ? `, финиш ${new Date(runP.finishedAt).toLocaleTimeString('ru-RU')}` : ''}</span>
          </div>
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-[var(--color-bg-hover)]">
            <div className={`h-full rounded-full transition-all ${runP.status === 'error' ? 'bg-[var(--color-negative)]' : runP.status === 'done' ? 'bg-[var(--color-positive)]' : 'bg-[var(--color-accent)]'}`}
              style={{ width: `${runP.total ? Math.round((runP.done / runP.total) * 100) : (runP.status === 'running' ? 5 : 100)}%` }} />
          </div>
          {runP.error && <div className="mt-2 text-sm text-[var(--color-negative)]"><AlertTriangle size={14} className="inline mr-1" /> {runP.error}</div>}
          {runP.status === 'done' && runP.summary && (
            <div className="mt-2 text-[12px] text-[var(--color-text)]">
              <code className="break-all whitespace-pre-wrap">{JSON.stringify(runP.summary, null, 1)}</code>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={branch} onChange={e => setBranch(e.target.value)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)]">
          <option value="">Все филиалы</option>{branches.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск менеджера…" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] w-full sm:w-64" />
        <span className="text-[12px] text-[var(--color-text-muted)]">{rows.length} менеджеров · сортировка — клик по заголовку</span>
        <span className="text-[11px] text-[var(--color-text-muted)] ml-auto">
          <span className={`inline-block rounded px-1.5 py-0.5 ${STATUS_CLS.drift_down}`}>просадка</span> — CUSUM пробил 4σ и база вне интервала ·{' '}
          <span className={`inline-block rounded px-1.5 py-0.5 ${STATUS_CLS.drift_up}`}>рост</span> · <span className="opacity-60">серым — мало данных</span>
        </span>
      </div>
      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {data && rows.length === 0 && <div className={`${cardCls} text-sm text-[var(--color-text-muted)]`}>Рядов пока нет — нажми «Справочники», затем «Пересчитать сегодня».</div>}
      <DiagnosesBlock onPick={id => { setQ(''); setOpen(id); }} />
      {rows.length > 0 && (
        <div className="scroll-x rounded-2xl border border-[var(--color-border)]">
          <table className="w-full text-[12px]">
            <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
              <tr>
                <Th k="name" align="left">Менеджер</Th>
                <Th k="plan">План</Th>
                <Th k="pct">Прогноз %</Th>
                <Th k="gap">Разрыв</Th>
                {COMPACT_NODES.map(id => <Th key={id} k={id} title={nodeMeta.get(id)?.name}>{SHORT[id] ?? id}</Th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(m => {
                const root = m.nodes.find(n => n.nodeId === 'plan_forecast_pct_month');
                const tr = (root?.trace ?? {}) as { gapRub?: number; silent?: boolean; tooLate?: boolean; fact?: number; forecast?: number };
                const isOpen = open === m.bitrixId;
                return (
                  <Frag key={m.bitrixId}>
                    <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] cursor-pointer" onClick={() => setOpen(isOpen ? null : m.bitrixId)}>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span className="font-semibold text-[var(--color-text)]">{m.name}</span></div>
                        <div className="text-[10.5px] text-[var(--color-text-muted)] pl-5">{m.branch} · {m.category}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtRub(m.plan)}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${root?.status === 'drift_down' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>
                        {root?.value !== null && root?.value !== undefined ? `${root.value.toFixed(0)}%` : '—'}{tr.silent && <span className="ml-1 text-[10px] font-normal text-[var(--color-text-muted)]">тихо</span>}{tr.tooLate && <span className="ml-1 text-[10px] font-normal text-[var(--color-warning)]">поздно</span>}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${tr.gapRub !== undefined && tr.gapRub > 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}`}>{tr.gapRub !== undefined ? fmtRub(tr.gapRub) : '—'}</td>
                      {COMPACT_NODES.map(id => {
                        const nr = m.nodes.find(n => n.nodeId === id);
                        return (
                          <td key={id} className="px-1.5 py-1.5 text-right tabular-nums" title={nr ? `n=${nr.n ?? '—'} · своё ${fmtV(nr.baseOwn, id)} · пиры ${fmtV(nr.basePeers, id)} · ${statusLabel(nr.status)}` : ''}>
                            <span className={`inline-block rounded px-1.5 py-0.5 ${STATUS_CLS[nr?.status ?? 'ok'] ?? ''}`}>
                              {nr?.status === 'drift_down' && <TrendingDown size={11} className="inline mr-0.5" />}{nr?.status === 'drift_up' && <TrendingUp size={11} className="inline mr-0.5" />}
                              {nr ? fmtV(nr.value, id) : '—'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                    {isOpen && (
                      <tr className="bg-[var(--color-bg)] border-t border-dashed border-[var(--color-border)]">
                        <td colSpan={4 + COMPACT_NODES.length} className="px-3 py-3">
                          <NodeDetails m={m} nodeMeta={nodeMeta} />
                        </td>
                      </tr>
                    )}
                  </Frag>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function Frag({ children }: { children: React.ReactNode }) { return <>{children}</>; }
function Chip({ children }: { children: React.ReactNode }) { return <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-hover)] px-2 py-0.5 text-[var(--color-text)]">{children}</span>; }

function NodeDetails({ m, nodeMeta }: { m: Mgr; nodeMeta: Map<string, NodeMeta> }) {
  const root = m.nodes.find(n => n.nodeId === 'plan_forecast_pct_month');
  const tr = (root?.trace ?? {}) as Record<string, number | boolean>;
  const rows = [...m.nodes].sort((a, b) => (nodeMeta.get(a.nodeId)?.sort_order ?? 999) - (nodeMeta.get(b.nodeId)?.sort_order ?? 999));
  return (
    <div className="flex flex-col gap-3">
      {root && (
        <div className="text-[12px] text-[var(--color-text)] flex flex-wrap gap-x-4 gap-y-1">
          <span>план <b>{fmtRub(Number(tr.plan))}</b></span><span>факт отгрузок <b>{fmtRub(Number(tr.fact))}</b></span>
          <span>продано-не-отгружено {fmtRub(Number(tr.pending))} → ожидаем <b>{fmtRub(Number(tr.pendingExpected))}</b></span>
          <span>темп продаж {fmtRub(Number(tr.paceDaily))}/раб.день × {String(tr.remainingDays)} дн × CR отгрузки {(Number(tr.crSaleToShip) * 100).toFixed(0)}%</span>
          <span>= прогноз <b>{fmtRub(Number(tr.forecast))}</b> ({Number(tr.pct).toFixed(0)}%)</span>
        </div>
      )}
      {(() => {
        const cs = m.nodes.find(n => n.nodeId === 'cross_sell_expected_share');
        const top = (cs?.trace as { crossSell?: { from: string; expected: string; companyPct: number; ownPct: number | null; n: number }[] } | null)?.crossSell ?? [];
        return top.length ? (
          <div className="text-[12px] text-[var(--color-text)]">
            <span className="font-semibold">Кросс-продажа, где отстаёт от компании:</span>{' '}
            {top.map(t => <span key={t.from} className="mr-3">после «{t.from}» → «{t.expected}»: у него {t.ownPct}% против {t.companyPct}% по компании (n={t.n})</span>)}
          </div>
        ) : null;
      })()}
      <div className="scroll-x rounded-xl border border-[var(--color-border)]">
        <table className="w-full text-[12px]">
          <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr><th className="px-2 py-1.5 text-left">Узел</th><th className="px-2 py-1.5 text-right">Значение</th><th className="px-2 py-1.5 text-right">n</th><th className="px-2 py-1.5 text-right">Интервал 90%</th><th className="px-2 py-1.5 text-right">Своё (пред. окно)</th><th className="px-2 py-1.5 text-right">Пиры</th><th className="px-2 py-1.5 text-right">EWMA</th><th className="px-2 py-1.5 text-right">CUSUM−/σ</th><th className="px-2 py-1.5 text-left">Статус</th></tr>
          </thead>
          <tbody>
            {rows.map(n => {
              const meta = nodeMeta.get(n.nodeId);
              return (
                <tr key={n.nodeId} className="border-t border-[var(--color-border)]">
                  <td className="px-2 py-1.5 text-[var(--color-text)]"><span title={meta?.description ?? ''}>{meta?.name ?? n.nodeId}</span> <span className="text-[10px] text-[var(--color-text-muted)]">{meta?.window_kind}</span></td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmtV(n.value, n.nodeId)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{n.n ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{n.ciLow !== null && n.ciHigh !== null ? `${n.ciLow.toFixed(1)}–${n.ciHigh.toFixed(1)}` : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtV(n.baseOwn, n.nodeId)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtV(n.basePeers, n.nodeId)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{n.ewma !== null ? fmtV(n.ewma, n.nodeId) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{n.sigma && n.cusumNeg !== null ? (n.cusumNeg / n.sigma).toFixed(1) : '—'}</td>
                  <td className={`px-2 py-1.5 whitespace-nowrap ${STATUS_CLS[n.status] ?? ''}`}>{n.status === 'ok' ? <Minus size={12} className="inline" /> : n.status === 'insufficient_data' ? <HelpCircle size={12} className="inline" /> : null} {statusLabel(n.status)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Диагнозы (ТЗ §11 п.1): что система считает проблемой и какой рычаг предлагает ──
const DIAG_STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: 'открыт', tone: 'bg-[color-mix(in_srgb,var(--color-negative)_14%,transparent)] text-[var(--color-negative)]' },
  queued: { label: 'в очереди', tone: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]' },
  in_scenario: { label: 'в сценарии', tone: 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]' },
  disputed: { label: 'оспорен', tone: 'bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] text-[var(--color-warning)]' },
  closed: { label: 'закрыт', tone: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]' },
};
const REASONS: { key: string; label: string }[] = [
  { key: 'wrong_lever', label: 'Не тот рычаг' }, { key: 'not_managers_fault', label: 'Не вина менеджера' },
  { key: 'data_error', label: 'Ошибка в данных' }, { key: 'already_handled', label: 'Уже решается' }, { key: 'other', label: 'Другое' },
];

function DiagnosesBlock({ onPick }: { onPick: (bitrixId: number) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ diagnoses: Diagnosis[] }>({ queryKey: ['diag-diagnoses'], queryFn: () => fetch('/api/diag/diagnoses').then(r => r.json()), refetchOnWindowFocus: false });
  const [openId, setOpenId] = useState<number | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [tab, setTab] = useState<'levers' | 'observations'>('levers');
  const dispute = useMutation({
    mutationFn: (v: { id: number; reason: string; comment: string }) => fetch('/api/diag/diagnoses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }).then(r => r.json()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['diag-diagnoses'] }),
  });
  const all = (data?.diagnoses ?? []).filter(d => showClosed || d.status !== 'closed');
  const levers = all.filter(d => d.leverId);
  const obs = all.filter(d => !d.leverId);
  const list = tab === 'levers' ? levers : obs;
  const control = levers.filter(d => d.status !== 'closed' && d.arm === 'control').length;
  return (
    <section className={cardCls}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {([['levers', `Есть что сказать (${levers.length})`], ['observations', `Наблюдения РОПу (${obs.length})`]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`min-h-9 rounded-lg px-3 text-sm transition-colors ${tab === k ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)] font-semibold' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[12px] text-[var(--color-text-muted)]">
          <span>в контроле {control}</span>
          <label className="inline-flex items-center gap-1.5 min-h-8"><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" /> закрытые за 14 дн</label>
        </div>
      </div>
      <p className="mb-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
        {tab === 'levers'
          ? 'Просадка подтверждена и статистически (σ), и практически: отклонение от базы больше минимально значимого И значение хуже нормы узла. Внутри нормы диагноза нет, даже если формально «стало хуже». Рычаг — что конкретно делать; один открытый фокус на менеджера, остальное в очереди.'
          : 'Узел просел, но ни один рычаг под ним не отклонился значимо — автоматике сказать нечего, нужен человек. Фокус менеджера такие наблюдения не занимают.'}
      </p>
      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {data && list.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">{tab === 'levers' ? 'Диагнозов с рычагом нет.' : 'Наблюдений нет.'}</div>}
      {list.length > 0 && (
        <div className="scroll-x rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-[12px]">
            <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
              <tr>
                <th className="px-2 py-2 text-left">Менеджер</th>
                <th className="px-2 py-2 text-left">Что просело</th>
                {tab === 'levers' && <th className="px-2 py-2 text-left">Что делать</th>}
                <th className="px-2 py-2 text-right">Разрыв к плану</th>
                <th className="px-2 py-2 text-right">Score</th>
                {tab === 'levers' && <th className="px-2 py-2 text-left">Рука</th>}
                <th className="px-2 py-2 text-left">Статус</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.map(d => {
                const tr = (d.trace ?? {}) as {
                  root?: { gapRub?: number; tooLate?: boolean };
                  node?: { value?: number; base?: number; worse?: number; devSigma?: number; n?: number; normGood?: number | null; unit?: string | null };
                  lever?: { value?: number; base?: number; devSigma?: number; n?: number; normGood?: number | null; unit?: string | null; selfLever?: boolean; edgeStatus?: string; edgeWeight?: number };
                  descendPath?: string[]; candidates?: { node: string; lever: string | null; score: number }[]; arm?: { reason?: string }; mode?: string;
                };
                const isOpen = openId === d.id;
                const st = DIAG_STATUS[d.status] ?? { label: d.status, tone: '' };
                const n = tr.node, l = tr.lever;
                return (
                  <Frag key={d.id}>
                    <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] cursor-pointer align-top" onClick={() => setOpenId(isOpen ? null : d.id)}>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <button className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent)]" onClick={e => { e.stopPropagation(); onPick(d.bitrixId); }}>{d.managerName}</button>
                        {d.mode === 'onboarding' && <span className="ml-1 text-[10px] font-normal text-[var(--color-text-muted)]">новичок</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="text-[var(--color-text)]">{d.nodeName}</div>
                        <div className="text-[11px] text-[var(--color-text-muted)]">
                          <b className="text-[var(--color-negative)]">{fmtUnit(n?.value, n?.unit)}</b> против {fmtUnit(n?.base, n?.unit)}
                          {n?.normGood !== null && n?.normGood !== undefined && <> · норма {fmtUnit(n.normGood, n.unit)}</>}
                          {n?.n ? ` · n=${n.n}` : ''} · {(n?.devSigma ?? 0).toFixed(1)}σ
                        </div>
                      </td>
                      {tab === 'levers' && (
                        <td className="px-2 py-1.5">
                          <div className="text-[var(--color-text)]">{l?.selfLever ? <span title="Просел сам лист поведения — действие в нём же">{d.leverName}</span> : d.leverName}</div>
                          {l && !l.selfLever && (
                            <div className="text-[11px] text-[var(--color-text-muted)]">{fmtUnit(l.value, l.unit)} против {fmtUnit(l.base, l.unit)}{l.n ? ` · n=${l.n}` : ''} · {(l.devSigma ?? 0).toFixed(1)}σ</div>
                          )}
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{tr.root?.gapRub ? fmtRub(tr.root.gapRub) : '—'}{tr.root?.tooLate && <span className="ml-1 text-[10px] text-[var(--color-warning)]">поздно</span>}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{d.score?.toFixed(2) ?? '—'}</td>
                      {tab === 'levers' && (
                        <td className="px-2 py-1.5 whitespace-nowrap">{d.arm === 'control' ? <span className="rounded px-1.5 py-0.5 bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]">контроль</span> : <span className="rounded px-1.5 py-0.5 bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]">воздействие</span>}</td>
                      )}
                      <td className="px-2 py-1.5 whitespace-nowrap"><span className={`rounded px-1.5 py-0.5 ${st.tone}`}>{st.label}{d.outcome ? ` · ${d.outcome}` : ''}</span></td>
                      <td className="px-2 py-1.5 text-right">
                        {(d.status === 'open' || d.status === 'queued') && (
                          <select className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[11px] text-[var(--color-text)]" defaultValue="" onClick={e => e.stopPropagation()}
                            onChange={e => { const reason = e.target.value; if (!reason) return; const comment = prompt('Комментарий (не обязательно):') ?? ''; dispute.mutate({ id: d.id, reason, comment }); e.target.value = ''; }}>
                            <option value="">Не согласен…</option>{REASONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-[var(--color-bg)] border-t border-dashed border-[var(--color-border)]">
                        <td colSpan={tab === 'levers' ? 8 : 6} className="px-3 py-2 text-[12px] text-[var(--color-text)]">
                          <div className="flex flex-col gap-1">
                            <div><b>Рука:</b> {d.arm === 'control' ? 'контроль' : 'воздействие'} — {tr.arm?.reason ?? '—'}{l?.edgeStatus && <> · ребро {l.edgeStatus}, вес {l.edgeWeight}</>}</div>
                            {tr.descendPath && tr.descendPath.length > 0 && <div><b>Спуск по дереву:</b> {[d.nodeId, ...tr.descendPath].join(' → ')}</div>}
                            {tr.candidates && tr.candidates.length > 0 && <div><b>Кандидаты:</b> {tr.candidates.map(c => `${c.node} → ${c.lever ?? '∅'} (${c.score})`).join(' · ')}</div>}
                            <details><summary className="cursor-pointer text-[var(--color-text-muted)]">Трасса JSON</summary><pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-[var(--color-bg-surface)] p-2 text-[11px]">{JSON.stringify(d.trace, null, 1)}</pre></details>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Frag>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
