'use client';
// Экран диагностики, фаза 1 (ТЗ №1 §11): таблица менеджеров × узлы дерева с состояниями,
// прогноз плана и разрыв, раскрытие менеджера — все узлы с базами, интервалом, n, следом.
// Кнопки ручного пересчёта — пока движок не на планировщике.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Play, ChevronDown, ChevronRight, AlertTriangle, TrendingDown, TrendingUp, Minus, HelpCircle } from 'lucide-react';

interface NodeRow { nodeId: string; asOf: string; tickNo: number | null; value: number | null; n: number | null; ciLow: number | null; ciHigh: number | null; ewma: number | null; cusumNeg: number | null; baseOwn: number | null; basePeers: number | null; baseTarget: number | null; sigma: number | null; status: string; trace: Record<string, unknown> | null }
interface Mgr { bitrixId: number; name: string; branch: string; category: string; plan: number | null; nodes: NodeRow[] }
interface NodeMeta { id: string; name: string; node_kind: string; window_kind: string; controllable: string; higher_is_better: boolean; sort_order: number; description: string | null }
interface RunProgress { id: number; kind: string; status: 'running' | 'done' | 'error'; stage: string | null; total: number; done: number; summary: Record<string, unknown> | null; error: string | null; startedAt: string; finishedAt: string | null }
interface Overview { today: string; nodes: NodeMeta[]; managers: Mgr[]; refs: { what: string; n: number; at: string | null }[]; activeManagers: number }

const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';
const cardCls = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4';

const COMPACT_NODES = ['cr_deal_to_sale', 'cr_deal_to_priced', 'cr_priced_to_reservation', 'cr_reservation_to_sale', 'booking_call_rate_reserved', 'calls_touch_speed_median', 'price_speed_median_hours', 'calls_deals_no_call', 'zombie_share', 'calls_silence_deals'];
const SHORT: Record<string, string> = {
  cr_deal_to_sale: 'CR→продажа', cr_deal_to_priced: 'CR→цена', cr_priced_to_reservation: 'цена→бронь', cr_reservation_to_sale: 'бронь→продажа',
  booking_call_rate_reserved: 'прозвон броней', calls_touch_speed_median: '1-е касание, мин', price_speed_median_hours: 'до цены, ч',
  calls_deals_no_call: 'без звонка', zombie_share: 'зомби, %', calls_silence_deals: 'тишина, шт',
};
const fmtRub = (v: number | null) => (v === null ? '—' : `${Math.round(v / 1000).toLocaleString('ru-RU')} т.₽`);
const fmtV = (v: number | null, nodeId: string) => {
  if (v === null) return '—';
  if (nodeId.startsWith('cr_') || nodeId.includes('rate') || nodeId.includes('share') || nodeId.includes('no_call') || nodeId.includes('pct')) return `${v.toFixed(1)}%`;
  if (nodeId.includes('median') || nodeId.includes('avg')) return v.toFixed(1);
  return Math.round(v).toLocaleString('ru-RU');
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
  const [open, setOpen] = useState<number | null>(null);
  const nodeMeta = useMemo(() => new Map((data?.nodes ?? []).map(n => [n.id, n])), [data]);
  const branches = useMemo(() => [...new Set((data?.managers ?? []).map(m => m.branch))].sort(), [data]);
  const rows = useMemo(() => {
    const list = (data?.managers ?? []).filter(m => !branch || m.branch === branch);
    const gap = (m: Mgr) => (m.nodes.find(n => n.nodeId === 'plan_forecast_pct_month')?.trace as { gapRub?: number } | null)?.gapRub ?? -Infinity;
    return list.sort((a, b) => gap(b) - gap(a));
  }, [data, branch]);
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
        <span className="text-[12px] text-[var(--color-text-muted)]">{rows.length} менеджеров · сортировка по разрыву к плану</span>
      </div>
      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {data && rows.length === 0 && <div className={`${cardCls} text-sm text-[var(--color-text-muted)]`}>Рядов пока нет — нажми «Справочники», затем «Пересчитать сегодня».</div>}
      {rows.length > 0 && (
        <div className="scroll-x rounded-2xl border border-[var(--color-border)]">
          <table className="w-full text-[12px]">
            <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
              <tr>
                <th className="px-2 py-2 text-left">Менеджер</th>
                <th className="px-2 py-2 text-right">План</th>
                <th className="px-2 py-2 text-right">Прогноз %</th>
                <th className="px-2 py-2 text-right">Разрыв</th>
                {COMPACT_NODES.map(id => <th key={id} className="px-2 py-2 text-right whitespace-nowrap" title={nodeMeta.get(id)?.name}>{SHORT[id] ?? id}</th>)}
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
                          <td key={id} className="px-1.5 py-1.5 text-right tabular-nums" title={nr ? `n=${nr.n ?? '—'} · своё ${fmtV(nr.baseOwn, id)} · пиры ${fmtV(nr.basePeers, id)} · ${nr.status}` : ''}>
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
                  <td className={`px-2 py-1.5 whitespace-nowrap ${STATUS_CLS[n.status] ?? ''}`}>{n.status === 'ok' ? <Minus size={12} className="inline" /> : n.status === 'insufficient_data' ? <HelpCircle size={12} className="inline" /> : null} {n.status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
