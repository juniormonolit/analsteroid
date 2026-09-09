'use client';
// Оценка эффективности сценариев коучинга (владелец 09.09: «по каждому сценарию видеть
// эффективность в целом и для кого из менеджеров как он отработал; фиксировать
// стартовый показатель, текущий, достигнут ли целевой и удержан ли»).
//  - ScenarioResultsBlock — сводка по сценариям (сколько цепочек, доля «удержал цель»,
//    средний сдвиг) + таблица цепочек с фильтрами сценарий / менеджер / итог.
//  - ScenarioJournalModal — то же по одному сценарию + отправленные сообщения.
// Итог цепочки считает движок (trackRuns): held — ≥ порога holdDays подряд (единственный
// «максимальный успех»), holding — достиг и держит, reached_lost — достиг и потерял,
// improved / same / worse — порог не взят.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronRight, History, X, BarChart3, Trophy } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { DataType } from '@/lib/metrics/types';
import { fmtDate, fmtV, jsonOrThrow, Chip } from './ScenariosTab';

export type RunOutcome = 'held' | 'holding' | 'reached_lost' | 'improved' | 'same' | 'worse';
export interface RunRow {
  id: string; scenarioId: string; scenarioName: string; bitrixId: number; managerName: string; branch: 'below' | 'norm'; status: 'open' | 'closed';
  startValue: number | null; lastValue: number | null; currentValue: number | null; threshold: number | null; baseValue: number | null;
  outcome: RunOutcome | null; closedReason: string | null; messages: number; resumeAt: string | null;
  reachedAt: string | null; atBaseAt: string | null; streakSince: string | null; held: boolean; heldAt: string | null;
  trackUntil: string | null; tracking: 'active' | 'done'; createdAt: string; closedAt: string | null;
  track: { day: string; value: number | null }[];
}
interface Agg {
  scenarioId: string; scenarioName: string; holdDays: number | null; total: number; open: number; tracking: number; belowTotal: number;
  held: number; holding: number; reachedLost: number; improved: number; same: number; worse: number; praise: number; avgDelta: number | null; messages: number;
}

export const OUTCOME_META: Record<RunOutcome, { label: string; tone: 'pos' | 'neg' | 'warn' | undefined }> = {
  held:         { label: 'удержал цель 🏆', tone: 'pos' },
  holding:      { label: 'достиг, удерживает', tone: 'pos' },
  reached_lost: { label: 'достиг, но не удержал', tone: 'warn' },
  improved:     { label: 'подрос, порог не взят', tone: 'warn' },
  same:         { label: 'без изменений', tone: undefined },
  worse:        { label: 'стало хуже', tone: 'neg' },
};
const cardCls = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4';
const inputCls = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';
const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const fmtDay = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('.');
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
const todayYmd = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

function useResults(scenarioId?: string, managerId?: number | null) {
  const qs = new URLSearchParams();
  if (scenarioId) qs.set('scenarioId', scenarioId);
  if (managerId) qs.set('managerId', String(managerId));
  return useQuery<{ runs: RunRow[]; byScenario: Agg[] }>({
    queryKey: ['bot-scenario-results', scenarioId ?? '', managerId ?? ''],
    queryFn: () => fetch(`/api/settings/bots/scenarios/results?${qs}`).then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export function ScenarioResultsBlock({ dataTypes }: { dataTypes: Map<string, DataType> }) {
  const [scenarioId, setScenarioId] = useState('');
  const [managerQ, setManagerQ] = useState('');
  const [outcome, setOutcome] = useState<RunOutcome | 'open' | 'tracking' | ''>('');
  const { data, isLoading } = useResults(scenarioId || undefined);
  const rows = useMemo(() => {
    const q = managerQ.trim().toLowerCase();
    return (data?.runs ?? []).filter(r =>
      (!q || r.managerName.toLowerCase().includes(q)) &&
      (!outcome || (outcome === 'open' ? r.status === 'open' : outcome === 'tracking' ? r.tracking === 'active' : r.outcome === outcome)));
  }, [data, managerQ, outcome]);
  const scenarios = useMemo(() => [...new Map((data?.byScenario ?? []).map(a => [a.scenarioId, a.scenarioName])).entries()], [data]);

  return (
    <section className={cardCls}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)] inline-flex items-center gap-2"><BarChart3 size={16} /> Результаты: как сценарии работают</h2>
        <span className="text-xs text-[var(--color-text-muted)]">{data ? `${data.runs.length} цепочек` : ''}</span>
      </div>
      <p className="mb-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
        Единица оценки — цепочка: у менеджера сработал триггер, бот вёл его по блокам, потом ещё N дней наблюдал показатель.
        Порог и цель фиксируются на старте. <b>Удержал цель</b> — держался ≥ порога заданное число дней подряд (только это —
        полный успех); <b>достиг, удерживает</b> — серия идёт; <b>достиг, но не удержал</b> — взял порог и снова провалился;
        <b>подрос</b> / <b>без изменений</b> / <b>хуже</b> — порог не взят. Ветка «в норме» (похвалы) — отдельно, без оценки.
      </p>

      {data && data.byScenario.length > 0 && (
        <div className="scroll-x mb-4 rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-[12px]">
            <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
              <tr>
                <th className="px-2 py-2 text-left">Сценарий</th>
                <th className="px-2 py-2 text-right">Цепочек «просадка»</th>
                <th className="px-2 py-2 text-right text-[var(--color-positive)]"><Trophy size={11} className="inline" /> Удержали</th>
                <th className="px-2 py-2 text-right">Удерживают</th>
                <th className="px-2 py-2 text-right">Достигли, потеряли</th>
                <th className="px-2 py-2 text-right">Подросли</th>
                <th className="px-2 py-2 text-right">Без изм.</th>
                <th className="px-2 py-2 text-right text-[var(--color-negative)]">Хуже</th>
                <th className="px-2 py-2 text-right">Ср. сдвиг</th>
                <th className="px-2 py-2 text-right">Идёт / наблюдаем</th>
                <th className="px-2 py-2 text-right">Похвал</th>
                <th className="px-2 py-2 text-right">Сообщ.</th>
              </tr>
            </thead>
            <tbody>
              {data.byScenario.map(a => {
                const dt = dataTypes.get(a.scenarioId) ?? 'decimal';
                return (
                  <tr key={a.scenarioId} className="border-t border-[var(--color-border)]">
                    <td className="px-2 py-1.5 font-semibold text-[var(--color-text)]">{a.scenarioName}{a.holdDays && <div className="text-[10px] font-normal text-[var(--color-text-muted)]">удержание {a.holdDays} дн.</div>}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{a.belowTotal}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-[var(--color-positive)]">{a.held} <span className="font-normal text-[var(--color-text-muted)]">({pct(a.held, a.belowTotal)})</span></td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{a.holding}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-warning)]">{a.reachedLost}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{a.improved}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{a.same}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-negative)]">{a.worse}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${a.avgDelta !== null && a.avgDelta < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}`}>
                      {a.avgDelta === null ? '—' : `${a.avgDelta > 0 ? '+' : ''}${fmtV(a.avgDelta, dt)}`}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{a.open} / {a.tracking}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{a.praise}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{a.messages}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mb-2 flex flex-wrap gap-2">
        <select value={scenarioId} onChange={e => setScenarioId(e.target.value)} className={inputCls}>
          <option value="">Все сценарии</option>
          {scenarios.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <input value={managerQ} onChange={e => setManagerQ(e.target.value)} placeholder="Менеджер…" className={`${inputCls} w-full sm:w-56`} />
        <select value={outcome} onChange={e => setOutcome(e.target.value as RunOutcome | 'open' | 'tracking' | '')} className={inputCls}>
          <option value="">Любой итог</option>
          <option value="open">Цепочка идёт</option>
          <option value="tracking">Наблюдаем</option>
          {(Object.keys(OUTCOME_META) as RunOutcome[]).map(k => <option key={k} value={k}>{OUTCOME_META[k].label}</option>)}
        </select>
      </div>
      {isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>
        : rows.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">Цепочек пока нет — появятся, когда включённый сценарий сработает по кому-то из менеджеров.</div>
        : <RunsTable rows={rows} dataTypes={dataTypes} showScenario />}
    </section>
  );
}

function Spark({ track, threshold, start }: { track: { day: string; value: number | null }[]; threshold: number | null; start: number | null }) {
  const pts = track.filter(t => t.value !== null) as { day: string; value: number }[];
  if (pts.length < 2) return null;
  const vals = pts.map(p => p.value).concat(threshold !== null ? [threshold] : [], start !== null ? [start] : []);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const W = 96, H = 24;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / span) * (H - 4) - 2;
  return (
    <svg width={W} height={H} className="shrink-0 overflow-visible" aria-hidden>
      {threshold !== null && <line x1={0} x2={W} y1={y(threshold)} y2={y(threshold)} stroke="var(--color-positive)" strokeDasharray="2 2" strokeWidth={1} />}
      <polyline fill="none" stroke="var(--color-accent)" strokeWidth={1.5} points={pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
    </svg>
  );
}

export function RunsTable({ rows, dataTypes, showScenario }: { rows: RunRow[]; dataTypes: Map<string, DataType>; showScenario?: boolean }) {
  const today = todayYmd();
  return (
    <div className="scroll-x rounded-xl border border-[var(--color-border)]">
      <table className="w-full text-[12px]">
        <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
          <tr>
            <th className="px-2 py-2 text-left">Старт</th>
            <th className="px-2 py-2 text-left">Менеджер</th>
            {showScenario && <th className="px-2 py-2 text-left">Сценарий</th>}
            <th className="px-2 py-2 text-left">Ветка</th>
            <th className="px-2 py-2 text-right">Старт → сейчас</th>
            <th className="px-2 py-2 text-right">Порог / цель</th>
            <th className="px-2 py-2 text-left">Динамика</th>
            <th className="px-2 py-2 text-left">Достиг</th>
            <th className="px-2 py-2 text-left">Удержание</th>
            <th className="px-2 py-2 text-right">Сообщ.</th>
            <th className="px-2 py-2 text-left">Итог</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const dt = dataTypes.get(r.scenarioId) ?? 'decimal';
            const cur = r.currentValue ?? r.lastValue;
            const delta = r.startValue !== null && cur !== null ? cur - r.startValue : null;
            const streak = r.streakSince ? daysBetween(r.streakSince, today) + 1 : 0;
            return (
              <tr key={r.id} className="border-t border-[var(--color-border)]">
                <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">{fmtDate(r.createdAt)}</td>
                <td className="px-2 py-1.5 font-semibold text-[var(--color-text)] whitespace-nowrap">{r.managerName}</td>
                {showScenario && <td className="px-2 py-1.5 text-[var(--color-text)]">{r.scenarioName}</td>}
                <td className="px-2 py-1.5 whitespace-nowrap">{r.branch === 'below' ? <Chip tone="neg">просадка</Chip> : <Chip tone="pos">в норме</Chip>}</td>
                <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap text-[var(--color-text)]">
                  {fmtV(r.startValue, dt)} <ArrowRight size={10} className="inline text-[var(--color-text-muted)]" /> <b>{fmtV(cur, dt)}</b>
                  {delta !== null && <span className={`ml-1 text-[10.5px] ${delta < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}`}>({delta > 0 ? '+' : ''}{fmtV(delta, dt)})</span>}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap text-[var(--color-text-muted)]">{fmtV(r.threshold, dt)} / {fmtV(r.baseValue, dt)}</td>
                <td className="px-2 py-1.5"><Spark track={r.track} threshold={r.threshold} start={r.startValue} /></td>
                <td className="px-2 py-1.5 whitespace-nowrap text-[11px]">
                  {r.reachedAt ? <span className="text-[var(--color-positive)]">порог {fmtDay(r.reachedAt)}</span> : <span className="text-[var(--color-text-muted)]">—</span>}
                  {r.atBaseAt && <div className="text-[var(--color-positive)]">цель {fmtDay(r.atBaseAt)}</div>}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap text-[11px]">
                  {r.held ? <span className="text-[var(--color-positive)] font-semibold">удержал{r.heldAt ? ` · ${fmtDay(r.heldAt)}` : ''}</span>
                    : streak > 0 ? <span className="text-[var(--color-text)]">серия {streak} дн.</span>
                    : <span className="text-[var(--color-text-muted)]">—</span>}
                  {r.tracking === 'active' && r.status === 'closed' && r.trackUntil && <div className="text-[var(--color-text-muted)]">наблюдаем до {fmtDay(r.trackUntil)}</div>}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.messages}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {r.branch === 'norm'
                    ? <span className="text-[var(--color-text-muted)]">{r.status === 'open' ? 'идёт' : 'похвала'}</span>
                    : <>
                        {r.outcome ? <Chip tone={OUTCOME_META[r.outcome].tone}>{OUTCOME_META[r.outcome].label}</Chip>
                          : <span className="text-[var(--color-text-muted)]">{r.closedReason === 'disabled' ? 'сценарий выключили' : 'ещё нет снимков'}</span>}
                        {r.status === 'open' && <div className="text-[10.5px] text-[var(--color-accent)]">цепочка идёт{r.resumeAt ? `, продолжение ${fmtDay(r.resumeAt)}` : ''}</div>}
                      </>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Журнал одного сценария (модалка из списка) ───────────────────────────────
interface EventRow { id: string; bitrixId: number; name: string; kind: string; value: number | null; threshold: number | null; text: string; branch: string | null; createdAt: string }

export function ScenarioJournalModal({ id, name, dataType, onClose }: { id: string; name: string; dataType: DataType; onClose: () => void }) {
  const results = useResults(id);
  const { data: ev } = useQuery<{ events: EventRow[] }>({
    queryKey: ['bot-scenario-events', id],
    queryFn: () => fetch(`/api/settings/bots/scenarios/${id}/events`).then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const [openEv, setOpenEv] = useState<string | null>(null);
  const dts = useMemo(() => new Map([[id, dataType]]), [id, dataType]);
  const messages = (ev?.events ?? []).filter(e => e.kind === 'message');
  const a = results.data?.byScenario[0];
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={<span className="inline-flex items-center gap-2"><History size={16} /> «{name}»: цепочки и сообщения</span>} desktopWidth="sm:max-w-5xl" bodyClassName="p-0">
      <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto overflow-x-hidden p-4 flex flex-col gap-4">
        {a && (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <Chip>цепочек «просадка» {a.belowTotal}</Chip>
            <Chip tone="pos"><Trophy size={11} /> удержали {a.held} ({pct(a.held, a.belowTotal)})</Chip>
            <Chip tone="pos">удерживают {a.holding}</Chip>
            <Chip tone="warn">достигли, потеряли {a.reachedLost}</Chip>
            <Chip>подросли {a.improved}</Chip><Chip>без изм. {a.same}</Chip><Chip tone="neg">хуже {a.worse}</Chip>
            <Chip>идёт {a.open} · наблюдаем {a.tracking}</Chip><Chip>похвал {a.praise}</Chip><Chip>сообщений {a.messages}</Chip>
          </div>
        )}
        <div>
          <div className="mb-1 text-sm font-semibold text-[var(--color-text)]">Цепочки ({results.data?.runs.length ?? '…'})</div>
          {results.data && results.data.runs.length === 0 && <div className="text-[12px] text-[var(--color-text-muted)]">Пока ни одной — сценарий ещё не срабатывал.</div>}
          {results.data && results.data.runs.length > 0 && <RunsTable rows={results.data.runs} dataTypes={dts} />}
        </div>
        <div>
          <div className="mb-1 text-sm font-semibold text-[var(--color-text)]">Отправленные сообщения ({messages.length})</div>
          {messages.length === 0 ? <div className="text-[12px] text-[var(--color-text-muted)]">Пока ничего не отправлялось.</div> : (
            <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
              {messages.map(e => {
                const isOpen = openEv === e.id;
                return (
                  <div key={e.id} className="px-3 py-2 text-[12px]">
                    <button onClick={() => setOpenEv(isOpen ? null : e.id)} className="w-full min-h-8 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-left">
                      <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{fmtDate(e.createdAt)}</span>
                      <span className="font-semibold text-[var(--color-text)]">{e.name}</span>
                      {e.branch && (e.branch === 'below' ? <Chip tone="neg">просадка</Chip> : <Chip tone="pos">в норме</Chip>)}
                      <span className="text-[var(--color-text-muted)]">{fmtV(e.value, dataType)}{e.threshold !== null && ` · порог ${fmtV(e.threshold, dataType)}`}</span>
                      {isOpen ? <ChevronDown size={13} className="ml-auto text-[var(--color-text-muted)]" /> : <ChevronRight size={13} className="ml-auto text-[var(--color-text-muted)]" />}
                    </button>
                    {isOpen && <div className="mt-1 rounded-lg bg-[var(--color-bg)] p-2 text-sm whitespace-pre-wrap break-words text-[var(--color-text)]">{e.text}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div><button className={btnCls} onClick={onClose}><X size={14} /> Закрыть</button></div>
      </div>
    </Modal>
  );
}
