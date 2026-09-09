'use client';
// Конструктор сценария авто-коучинга бота «Аналитик» — отдельная страница
// (/settings/bots/analitik/scenarios/[id]); владелец 09.09: «хочу конструктор
// чат-бота, чтобы строить цепочки и алгоритмы в виде сценариев, а не в попапе».
//
// Экран: шапка (название, сохранить, проверить) → блок «Триггер» (показатель, база,
// порог, кому, когда) → развилка на две ветки («ниже порога» / «в норме»), в каждой —
// вертикальная цепочка блоков с «+» между ними; «Проверка» ветвится на Да/Нет с
// вложенными цепочками. Внизу — превью на живых данных для ТЕКУЩЕГО черновика (без
// сохранения и без отправки). Формат и валидация — lib/jobs/scenarioFlow.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Clock, FlaskConical, GitBranch, Hourglass,
  MessageSquareText, Pencil, Play, Plus, RotateCcw, Search, Sparkles, Square, Target, Trash2, TrendingDown, Users, X, AlertTriangle, BellOff,
} from 'lucide-react';
import type { DataType } from '@/lib/metrics/types';
import {
  CONDITION_LABEL, defaultFlow, newNodeId, renderTemplate, terminates, validateFlow,
  type CheckCondition, type FlowBranch, type FlowNode, type ScenarioFlow,
} from '@/lib/jobs/scenarioFlow';
import { Chip, fmtV, jsonOrThrow, unitFor, type RunSummary } from './ScenariosTab';

// ── Типы API ─────────────────────────────────────────────────────────────────
interface MetricOpt { id: string; name: string; short: string | null; category: string | null; dataType: DataType; decimalPlaces: number; description: string | null; formula: string | null }
interface Options { metrics: MetricOpt[]; placeholders: { key: string; hint: string }[] }
interface ScenarioDto { id: string; name: string; enabled: boolean; flow: ScenarioFlow; checkHour: number; weekdaysOnly: boolean; metricName: string; metricDataType: DataType; stats: { open: number; sent30: number } }
interface ExecStep { nodeId: string | null; type: 'start' | 'message' | 'wait' | 'check' | 'end' | 'deferred'; label: string; text?: string; result?: boolean }
interface Eval {
  bitrixId: number; name: string; value: number | null; base: number | null; threshold: number | null; delta: number | null;
  status: 'no_data' | 'below' | 'between' | 'norm'; run: { branch: FlowBranch; nodeId: string | null; resumeAt: string | null } | null;
  steps: ExecStep[]; messages: { nodeId: string; text: string }[]; outcome: string; startBranch: FlowBranch | null;
}
interface Preview { metric: { id: string; name: string; dataType: DataType; decimalPlaces: number }; window: { from: string; to: string }; baselineWindow: { from: string; to: string } | null; evals: Eval[]; summary: RunSummary }

const inputCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';
const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';
const labelCls = 'text-[11px] text-[var(--color-text-muted)] mb-1';
const fmtDay = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('.');
const fmtDelta = (d: number | null, dt: DataType) => {
  if (d === null) return '—';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return dt === 'percent' ? `${sign}${Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.п.` : `${sign}${fmtV(Math.abs(d), dt)}`;
};

const NODE_META = {
  message: { label: 'Сообщение', Icon: MessageSquareText, cls: 'border-[var(--color-accent)]' },
  wait:    { label: 'Ждать',     Icon: Hourglass,         cls: 'border-[var(--color-warning)]' },
  check:   { label: 'Проверка',  Icon: GitBranch,         cls: 'border-[var(--color-text-muted)]' },
  end:     { label: 'Завершить', Icon: Square,            cls: 'border-[var(--color-negative)]' },
  restart: { label: 'В начало',  Icon: RotateCcw,         cls: 'border-[var(--color-accent)]' },
} as const;

// ── Страница ─────────────────────────────────────────────────────────────────
export function ScenarioEditor({ id }: { id: string }) {
  const isNew = id === 'new';
  const router = useRouter();
  const qc = useQueryClient();
  const { data: opts } = useQuery<Options>({
    queryKey: ['bot-scenario-options'],
    queryFn: () => fetch('/api/settings/bots/scenarios/options').then(jsonOrThrow),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  const { data: loaded, error: loadError } = useQuery<{ scenario: ScenarioDto }>({
    queryKey: ['bot-scenario', id],
    queryFn: () => fetch(`/api/settings/bots/scenarios?id=${id}`).then(jsonOrThrow),
    enabled: !isNew, refetchOnWindowFocus: false,
  });
  const { data: fns } = useQuery<{ functions: { key: string; enabled: boolean }[] }>({
    queryKey: ['bot-functions'],
    queryFn: () => fetch('/api/settings/bots/channels').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const fnEnabled = fns?.functions.find(f => f.key === 'scenarios')?.enabled ?? null;

  const [name, setName] = useState('');
  const [checkHour, setCheckHour] = useState(10);
  const [weekdaysOnly, setWeekdaysOnly] = useState(true);
  const [flow, setFlow] = useState<ScenarioFlow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(isNew ? null : id);
  const [enabled, setEnabled] = useState(false);

  // Инициализация: новый — шаблон владельца; существующий — из БД.
  useEffect(() => {
    if (flow) return;
    if (isNew && opts) {
      const metric = opts.metrics.find(m => m.id === 'cr_deal_to_sale_all') ?? opts.metrics.find(m => /^CR Сделка → Продажа/i.test(m.name)) ?? opts.metrics[0];
      setName('Конверсия в продажу — цель 15%');
      setFlow(defaultFlow(metric?.id ?? ''));
    } else if (!isNew && loaded) {
      const s = loaded.scenario;
      setName(s.name); setCheckHour(s.checkHour); setWeekdaysOnly(s.weekdaysOnly); setFlow(s.flow); setEnabled(s.enabled);
    }
  }, [isNew, opts, loaded, flow]);

  const update = useCallback((patch: (f: ScenarioFlow) => ScenarioFlow) => { setFlow(f => (f ? patch(f) : f)); setDirty(true); }, []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const errors = useMemo(() => (flow ? validateFlow(flow).errors : []), [flow]);
  const metric = useMemo(() => opts?.metrics.find(m => m.id === flow?.trigger.metricId) ?? null, [opts, flow]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { id: savedId ?? undefined, name, checkHour, weekdaysOnly, flow };
      const res = await fetch('/api/settings/bots/scenarios', {
        method: savedId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then(jsonOrThrow) as { id?: string };
      return res.id ?? savedId!;
    },
    onSuccess: (newId) => {
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['bot-scenarios'] });
      void qc.invalidateQueries({ queryKey: ['bot-scenario', newId] });
      if (!savedId) { setSavedId(newId); router.replace(`/settings/bots/analitik/scenarios/${newId}`); }
    },
  });
  const toggle = useMutation({
    mutationFn: () => fetch('/api/settings/bots/scenarios', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: savedId, enabled: !enabled }),
    }).then(jsonOrThrow),
    onSuccess: () => { setEnabled(e => !e); void qc.invalidateQueries({ queryKey: ['bot-scenarios'] }); },
  });

  const [previewOpen, setPreviewOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // При открытии — канва центрируется на «Триггере» (владелец 09.09: «центр, а не левый
  // верхний угол»): канва шире экрана, стартовый scrollLeft=0 показывал бы левый край ветки.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const centeredOnce = useRef(false);
  useEffect(() => {
    if (centeredOnce.current || !flow || !opts) return;
    const el = canvasRef.current, tg = triggerRef.current;
    if (!el || !tg) return;
    centeredOnce.current = true;
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, tg.offsetLeft + tg.offsetWidth / 2 - el.clientWidth / 2);
    });
  }, [flow, opts]);

  if (loadError) return <div className="p-6 text-sm text-[var(--color-negative)]">{(loadError as Error).message}</div>;
  if (!flow || !opts) return <div className="p-6 text-sm text-[var(--color-text-muted)]">Загрузка конструктора…</div>;

  const dt: DataType = metric?.dataType ?? 'decimal';

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Шапка — вне скролла, всегда на месте */}
      <div className="shrink-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 sm:px-6 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/settings/bots/analitik?tab=scenarios" onClick={e => { if (dirty && !confirm('Есть несохранённые изменения. Уйти без сохранения?')) e.preventDefault(); }}
            className="tap-target inline-flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><ArrowLeft size={16} /> Сценарии</Link>
          <input value={name} onChange={e => { setName(e.target.value); setDirty(true); }} placeholder="Название сценария"
            className="min-w-0 flex-1 basis-56 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-lg font-bold text-[var(--color-text)] outline-none hover:border-[var(--color-border)] focus:border-[var(--color-accent)]" />
          <div className="flex items-center gap-2 ml-auto">
            {savedId && (
              <button onClick={() => toggle.mutate()} disabled={toggle.isPending || dirty} title={dirty ? 'Сначала сохрани' : enabled ? 'Выключить (открытые цепочки закроются)' : 'Включить'}
                className={`min-h-11 inline-flex items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors ${enabled
                  ? 'border-[var(--color-positive)] text-[var(--color-positive)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
                {enabled ? <><Check size={14} /> Включён</> : <><BellOff size={14} /> Выключен</>}
              </button>
            )}
            <button className={btnCls} onClick={() => { setPreviewOpen(true); setTimeout(() => previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}>
              <FlaskConical size={14} /> <span className="hidden sm:inline">Проверить на живых данных</span><span className="sm:hidden">Проверить</span>
            </button>
            <button className={btnPrimaryCls} disabled={!dirty && !!savedId || errors.length > 0 || !name.trim() || save.isPending} onClick={() => save.mutate()}>
              <Check size={14} /> {savedId ? 'Сохранить' : 'Создать (выключенным)'}
            </button>
          </div>
        </div>
        {(errors.length > 0 || save.isError || toggle.isError) && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-negative)]">
            {errors.map(e => <span key={e} className="inline-flex items-center gap-1"><AlertTriangle size={11} /> {e}</span>)}
            {save.isError && <span>{(save.error as Error).message}</span>}
            {toggle.isError && <span>{(toggle.error as Error).message}</span>}
          </div>
        )}
        {dirty && errors.length === 0 && <div className="mt-1 text-[11px] text-[var(--color-warning)]">Есть несохранённые изменения</div>}
      </div>

      {/* Канва: блок-схема. Блоки фиксированной ширины (CARD_W), каждый центрирован над
          своим поддеревом, «Проверка» — по центру над колонками Да/Нет. Вся область
          скроллится по обеим осям целиком (владелец 09.09: «хули он скроллится внутри
          области, а не всего экрана»), ширина канвы = самый широкий ряд веток. */}
      <div ref={canvasRef} className="flex-1 min-h-0 overflow-auto">
      <div className="relative w-max min-w-full p-3 sm:p-6 flex flex-col items-center gap-4">
        {fnEnabled === false && (
          <div className="w-[1040px] max-w-full rounded-xl border border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-text)]">
            <BellOff size={12} className="inline mr-1 text-[var(--color-warning)]" /> Функция бота «Сценарии коучинга» выключена — сценарии можно строить и проверять, но в Битрикс ничего не уйдёт,
            пока не включишь её во вкладке <Link href="/settings/bots/analitik?tab=functions" className="text-[var(--color-accent)] hover:underline">«Функции»</Link>.
          </div>
        )}

        {/* Триггер */}
        <div ref={triggerRef} className="w-[1040px] max-w-full">
        <TriggerCard flow={flow} metric={metric} opts={opts} update={update}
          checkHour={checkHour} setCheckHour={h => { setCheckHour(h); setDirty(true); }}
          weekdaysOnly={weekdaysOnly} setWeekdaysOnly={v => { setWeekdaysOnly(v); setDirty(true); }} />
        </div>

        {/* Развилка */}
        <div className="flex justify-center -my-1"><ArrowDown size={18} className="text-[var(--color-text-muted)]" /></div>
        {/* Развилка триггера: две колонки-ветки, каждая центрирует свои блоки */}
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <BranchCol side="left" label="Ниже порога — просадка" color="var(--color-negative)"
            hint={`значение < ${metric ? fmtV(baseOf(flow), dt) : 'база'} − ${flow.trigger.dropThreshold.toLocaleString('ru-RU')} ${unitFor(dt)}`} root terminated>
            <NodeList nodes={flow.below} onChange={list => update(f => ({ ...f, below: list }))} placeholders={opts.placeholders} sample={sampleCtx(flow, metric)} depth={0} />
          </BranchCol>
          <BranchCol side="right" label="В норме — на уровне цели или выше" color="var(--color-positive)" hint="значение ≥ базы; между порогом и базой — тишина" root terminated>
            <NodeList nodes={flow.norm} onChange={list => update(f => ({ ...f, norm: list }))} placeholders={opts.placeholders} sample={sampleCtx(flow, metric)} depth={0} />
          </BranchCol>
        </div>

        {/* Превью */}
        <div ref={previewRef} className="w-[1200px] max-w-full">
          {previewOpen && <PreviewPanel flow={flow} scenarioId={savedId} dirty={dirty} enabledScenario={enabled} fnEnabled={fnEnabled} onClose={() => setPreviewOpen(false)} />}
        </div>
      </div>
      </div>
    </div>
  );
}

function baseOf(flow: ScenarioFlow): number | null {
  return flow.trigger.baseline === 'target' ? flow.trigger.targetValue : null;
}

function sampleCtx(flow: ScenarioFlow, metric: MetricOpt | null): Record<string, string> {
  const dt: DataType = metric?.dataType ?? 'decimal';
  const dp = metric?.decimalPlaces ?? 1;
  const base = flow.trigger.baseline === 'target' ? (flow.trigger.targetValue ?? 0) : (dt === 'percent' ? 14.2 : 100);
  const drop = flow.trigger.dropThreshold;
  const val = base - drop - (dt === 'percent' ? 1.3 : Math.max(1, Math.abs(base) * 0.1));
  return {
    'имя': 'Иван', 'показатель': metric?.name ?? 'показатель', 'значение': fmtV(val, dt, dp), 'цель': fmtV(base, dt, dp),
    'порог': fmtV(base - drop, dt, dp), 'дельта': fmtDelta(val - base, dt), 'было': fmtV(val - (dt === 'percent' ? 0.8 : 1), dt, dp),
    'окно': String(flow.trigger.windowDays),
  };
}

// ── Триггер ──────────────────────────────────────────────────────────────────
function TriggerCard({ flow, metric, opts, update, checkHour, setCheckHour, weekdaysOnly, setWeekdaysOnly }: {
  flow: ScenarioFlow; metric: MetricOpt | null; opts: Options; update: (p: (f: ScenarioFlow) => ScenarioFlow) => void;
  checkHour: number; setCheckHour: (h: number) => void; weekdaysOnly: boolean; setWeekdaysOnly: (v: boolean) => void;
}) {
  const t = flow.trigger;
  const setT = (patch: Partial<ScenarioFlow['trigger']>) => update(f => ({ ...f, trigger: { ...f.trigger, ...patch } }));
  const dt: DataType = metric?.dataType ?? 'decimal';
  const unit = unitFor(dt);
  const [num, setNum] = useState<{ target: string; drop: string }>({ target: t.targetValue === null ? '' : String(t.targetValue), drop: String(t.dropThreshold) });
  const onNum = (k: 'target' | 'drop', raw: string) => {
    setNum(n => ({ ...n, [k]: raw }));
    const v = Number(raw.replace(',', '.'));
    if (k === 'target') setT({ targetValue: raw.trim() === '' || !Number.isFinite(v) ? null : v });
    else if (Number.isFinite(v)) setT({ dropThreshold: Math.abs(v) });
  };
  return (
    <section className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--color-text)]">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)]"><Target size={15} /></span>
        Триггер: показатель на менеджера
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4">
        <div className="flex flex-col gap-3">
          <MetricPicker metrics={opts.metrics} value={t.metricId} onChange={id => setT({ metricId: id })} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Num label="Окно, дней (до вчера)" value={t.windowDays} min={1} max={365} onChange={v => setT({ windowDays: v })} />
            <div className="col-span-2">
              <div className={labelCls}>База сравнения</div>
              <div className="flex gap-1.5">
                <Seg on={t.baseline === 'target'} onClick={() => setT({ baseline: 'target' })}>Цель</Seg>
                <Seg on={t.baseline === 'own_avg'} onClick={() => setT({ baseline: 'own_avg' })}>Своё среднее</Seg>
              </div>
            </div>
            {t.baseline === 'target'
              ? <div><div className={labelCls}>Цель{dt === 'percent' ? ', %' : unit ? `, ${unit}` : ''}</div><input inputMode="decimal" value={num.target} onChange={e => onNum('target', e.target.value)} className={inputCls} placeholder="15" /></div>
              : <Num label="Среднее за, дней" value={t.baselineDays} min={7} max={730} onChange={v => setT({ baselineDays: v })} />}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div><div className={labelCls}>Просадка{unit ? `, ${unit}` : ''}</div><input inputMode="decimal" value={num.drop} onChange={e => onNum('drop', e.target.value)} className={inputCls} placeholder="2" /></div>
            <Num label="Пауза после «просадки», дн." value={t.cooldownDays} min={0} max={365} onChange={v => setT({ cooldownDays: v })} />
            <Num label="Пауза после «в норме», дн." value={t.praiseCooldownDays} min={0} max={365} onChange={v => setT({ praiseCooldownDays: v })} />
            <div>
              <div className={labelCls}>Час проверки (МСК)</div>
              <div className="flex items-center gap-2">
                <select value={checkHour} onChange={e => setCheckHour(Number(e.target.value))} className={inputCls}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <Num label="Цель удержана: ≥ порога дней подряд" value={t.holdDays} min={1} max={365} onChange={v => setT({ holdDays: v })} />
            <Num label="Наблюдать после закрытия, дн." value={t.trackDays} min={0} max={365} onChange={v => setT({ trackDays: v })} />
            <label className="col-span-2 inline-flex items-center gap-2 text-sm text-[var(--color-text)] min-h-11">
              <input type="checkbox" checked={weekdaysOnly} onChange={e => setWeekdaysOnly(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              <Clock size={13} className="text-[var(--color-text-muted)]" /> Только по будням
            </label>
          </div>
          <div className="text-[10.5px] leading-snug text-[var(--color-text-muted)]">
            Оценка: на старте цепочки фиксируются стартовое значение, база и порог; дальше показатель снимается каждый день —
            пока цепочка идёт и ещё «наблюдать» дней после. «Удержал цель» = держался ≥ порога заданное число дней подряд;
            только это считается полным успехом (вкладка «Сценарии» → «Результаты»).
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] px-3 py-2 text-[12px] text-[var(--color-text)]">
            <TrendingDown size={12} className="inline mr-1 text-[var(--color-negative)]" />
            Порог = {t.baseline === 'target' ? fmtV(t.targetValue, dt) : 'своё среднее'} − {t.dropThreshold.toLocaleString('ru-RU')} {unit}
            {t.baseline === 'target' && t.targetValue !== null && <> = <b>{fmtV(t.targetValue - t.dropThreshold, dt)}</b></>}.
            Ниже порога → левая ветка; на уровне {t.baseline === 'target' ? 'цели' : 'своего среднего'} или выше → правая; между — тишина.
          </div>
        </div>
        <AudiencePicker flow={flow} update={update} />
      </div>
    </section>
  );
}

interface OrgTreeNode { id: string; bitrixId: string; name: string; children: OrgTreeNode[]; managers: { bitrixId: number; name: string }[] }

function subtreeManagerIds(n: OrgTreeNode): number[] {
  return [...n.managers.map(m => m.bitrixId), ...n.children.flatMap(subtreeManagerIds)];
}
function nodeMatches(n: OrgTreeNode, q: string): boolean {
  return !q || n.name.toLowerCase().includes(q) || n.managers.some(m => m.name.toLowerCase().includes(q)) || n.children.some(c => nodeMatches(c, q));
}

// Аудитория — дерево оргструктуры до менеджеров (владелец 09.09: «пикер как в отчётах,
// но чтобы раскрывался вплоть до менеджеров»). Отдел = тристейт-чекбокс на всех
// менеджеров поддерева; храним ВЫБРАННЫХ ЛЮДЕЙ (managerIds), не отделы — сценарий
// адресный, новые сотрудники отдела в него не попадают сами.
function AudiencePicker({ flow, update }: { flow: ScenarioFlow; update: (p: (f: ScenarioFlow) => ScenarioFlow) => void }) {
  const a = flow.audience;
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery<{ tree: OrgTreeNode[] }>({
    queryKey: ['bot-scenario-org-tree'],
    queryFn: () => fetch('/api/settings/bots/scenarios/org-tree').then(jsonOrThrow),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false, enabled: a.mode === 'selected',
  });
  const setA = (patch: Partial<ScenarioFlow['audience']>) => update(f => ({ ...f, audience: { ...f.audience, ...patch } }));
  const selected = useMemo(() => new Set(a.managerIds), [a.managerIds]);
  const toggle = (ids: number[], on: boolean) => {
    const next = new Set(selected);
    ids.forEach(id => (on ? next.add(id) : next.delete(id)));
    setA({ managerIds: [...next] });
  };
  const total = useMemo(() => (data?.tree ?? []).reduce((n, t) => n + subtreeManagerIds(t).length, 0), [data]);
  const qq = q.trim().toLowerCase();
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3 flex flex-col min-h-0">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]"><Users size={14} /> Кому</div>
      <div className="flex gap-1.5 mb-2">
        <Seg on={a.mode === 'all'} onClick={() => setA({ mode: 'all' })}>Всем менеджерам</Seg>
        <Seg on={a.mode === 'selected'} onClick={() => setA({ mode: 'selected' })}>Выбранным</Seg>
      </div>
      {a.mode === 'all' ? (
        <div className="text-[11px] leading-snug text-[var(--color-text-muted)]">
          Все работающие менеджеры (аккаунты manager*, активные в CRM за последние N дней — настройка «неактивные» во вкладке «Дайджест»).
        </div>
      ) : (
        <>
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
            <span className="text-[var(--color-text-muted)]">выбрано <b className="text-[var(--color-text)]">{a.managerIds.length}</b>{total ? ` из ${total}` : ''}</span>
            {a.managerIds.length > 0 && <button type="button" onClick={() => setA({ managerIds: [] })} className="text-[var(--color-accent)] hover:underline">Очистить</button>}
          </div>
          <div className="relative mb-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Отдел или менеджер…" className={`${inputCls} pl-7`} />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border)] py-1">
            {isLoading && <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">Загрузка оргструктуры…</div>}
            {data && data.tree.filter(n => nodeMatches(n, qq)).map(n => (
              <OrgNodeRow key={n.id} node={n} depth={0} selected={selected} onToggle={toggle} q={qq} />
            ))}
            {data && data.tree.length === 0 && <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">Оргструктура пуста</div>}
          </div>
        </>
      )}
    </div>
  );
}

function TriCheckbox({ state, onChange }: { state: 'none' | 'some' | 'all'; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [state]);
  // Без tap-target: его 44px-зона накрывала бы соседнюю стрелку (клик по галке разворачивал ветку).
  return <input ref={ref} type="checkbox" checked={state === 'all'} onChange={onChange} className="accent-[var(--color-accent)] w-4 h-4 shrink-0 cursor-pointer" />;
}

function OrgNodeRow({ node, depth, selected, onToggle, q }: { node: OrgTreeNode; depth: number; selected: Set<number>; onToggle: (ids: number[], on: boolean) => void; q: string }) {
  const ids = useMemo(() => subtreeManagerIds(node), [node]);
  const count = ids.filter(id => selected.has(id)).length;
  const state = count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
  const [expanded, setExpanded] = useState(depth === 0);
  const open = expanded || !!q; // при поиске раскрываем всё совпавшее
  const kids = node.children.filter(c => nodeMatches(c, q));
  const people = node.managers.filter(m => !q || m.name.toLowerCase().includes(q) || node.name.toLowerCase().includes(q));
  return (
    <div>
      <div className="flex items-center gap-2 min-h-10 hover:bg-[var(--color-bg-hover)] select-none" style={{ paddingLeft: 8 + depth * 14, paddingRight: 8 }}>
        <button type="button" onClick={() => setExpanded(v => !v)} aria-label={open ? 'Свернуть' : 'Развернуть'}
          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-border)]">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <TriCheckbox state={state} onChange={() => onToggle(ids, state !== 'all')} />
        <span onClick={() => onToggle(ids, state !== 'all')} className={`flex-1 truncate text-sm cursor-pointer ${depth === 0 ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>{node.name}</span>
        <span className="text-[10.5px] tabular-nums text-[var(--color-text-muted)]">{count ? `${count}/` : ''}{ids.length}</span>
      </div>
      {open && (
        <div>
          {kids.map(c => <OrgNodeRow key={c.id} node={c} depth={depth + 1} selected={selected} onToggle={onToggle} q={q} />)}
          {people.map(m => {
            const on = selected.has(m.bitrixId);
            return (
              <label key={m.bitrixId} className="flex items-center gap-2 min-h-10 hover:bg-[var(--color-bg-hover)] cursor-pointer" style={{ paddingLeft: 8 + (depth + 1) * 14 + 40, paddingRight: 8 }}>
                <input type="checkbox" checked={on} onChange={() => onToggle([m.bitrixId], !on)} className="accent-[var(--color-accent)] w-4 h-4 shrink-0" />
                <span className="truncate text-sm text-[var(--color-text)]">{m.name}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MetricPicker({ metrics, value, onChange }: { metrics: MetricOpt[]; value: string; onChange: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(!value);
  const chosen = metrics.find(m => m.id === value) ?? null;
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return metrics.filter(m => !n || m.name.toLowerCase().includes(n) || (m.category ?? '').toLowerCase().includes(n) || m.id.includes(n)).slice(0, 40);
  }, [metrics, q]);
  return (
    <div>
      <div className={labelCls}>Показатель (метрика каталога)</div>
      {chosen && !open ? (
        <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1"><b className="text-[var(--color-text)]">{chosen.name}</b>
              <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">{chosen.category ?? ''} · {chosen.dataType}</span></span>
            <button type="button" onClick={() => setOpen(true)} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-accent)]" title="Сменить показатель"><Pencil size={14} /></button>
          </div>
          {(chosen.description || chosen.formula) && (
            <div className="mt-1 text-[11px] leading-snug text-[var(--color-text-muted)] whitespace-pre-wrap">
              {chosen.formula && <div className="font-mono mb-0.5">{chosen.formula}</div>}
              {chosen.description}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск: конверсия, средний чек, звонки…" className={`${inputCls} pl-8`} autoFocus />
          </div>
          <div className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-[var(--color-border)]">
            {list.length === 0 && <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">Ничего не найдено</div>}
            {list.map(m => (
              <button key={m.id} type="button" onClick={() => { onChange(m.id); setOpen(false); }}
                className={`w-full min-h-11 text-left px-3 py-2 border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-bg-hover)] ${m.id === value ? 'bg-[var(--color-accent)]/10' : ''}`}>
                <div className="text-sm text-[var(--color-text)]">{m.name} <span className="text-[11px] text-[var(--color-text-muted)]">· {m.category ?? '—'} · {m.dataType}</span></div>
                {m.description && <div className="text-[11px] text-[var(--color-text-muted)] line-clamp-2">{m.description}</div>}
              </button>
            ))}
          </div>
          {chosen && <button type="button" className={`${btnCls} mt-2`} onClick={() => setOpen(false)}>Оставить «{chosen.name}»</button>}
        </>
      )}
    </div>
  );
}

// ── Блок-схема: колонки веток, блоки, коннекторы ─────────────────────────────
// Блок — карточка фиксированной ширины CARD_W. Список блоков — вертикальная колонка с
// центрированием (flex-col items-center): ширина колонки = самый широкий элемент, а
// самый широкий — ряд веток «Проверки» (две колонки Да/Нет рядом). Так «Проверка»
// сама встаёт по центру над своими ветками, как на блок-схеме, и ничего не растягивается.
const CARD_W = 'w-[500px]';
const COL_MIN = 'min-w-[560px]'; // колонка ветки: карточка + воздух под коннекторы

interface ListProps { nodes: FlowNode[]; onChange: (list: FlowNode[]) => void; placeholders: Options['placeholders']; sample: Record<string, string>; depth: number }

function NodeList({ nodes, onChange, placeholders, sample, depth }: ListProps) {
  const insert = (i: number, node: FlowNode) => onChange([...nodes.slice(0, i), node, ...nodes.slice(i)]);
  const replace = (i: number, node: FlowNode) => onChange(nodes.map((n, k) => (k === i ? node : n)));
  const remove = (i: number) => onChange(nodes.filter((_, k) => k !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= nodes.length) return;
    const copy = [...nodes]; [copy[i], copy[j]] = [copy[j], copy[i]]; onChange(copy);
  };
  return (
    <div className="flex flex-col items-center">
      {nodes.length === 0 && (
        <div className={`${CARD_W} rounded-xl border border-dashed border-[var(--color-border)] px-3 py-3 text-center text-[12px] text-[var(--color-text-muted)]`}>
          {depth === 0 ? 'Ветка пустая — бот ничего не сделает. Добавь первый блок:' : 'Пусто — цепочка идёт дальше по основной ветке'}
        </div>
      )}
      {nodes.map((n, i) => (
        <div key={n.id} className="flex flex-col items-center">
          {(i === 0 || !terminates([nodes[i - 1]])) && <AddBetween onAdd={node => insert(i, node)} />}
          {i > 0 && nodes[i - 1].type === 'end' && n.type === 'restart' && <div className="h-4 w-px bg-[var(--color-border)]" />}
          <NodeCard node={n} onChange={node => replace(i, node)} onRemove={() => remove(i)}
            onUp={i > 0 ? () => move(i, -1) : undefined} onDown={i < nodes.length - 1 ? () => move(i, 1) : undefined}
            placeholders={placeholders} sample={sample} />
          {n.type === 'check' && <div className="h-4 w-px bg-[var(--color-border)]" />}
          {n.type === 'check' && (
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <BranchCol side="left" label="Да" color="var(--color-positive)" terminated={terminates(n.yes)}>
                <NodeList nodes={n.yes} onChange={list => replace(i, { ...n, yes: list })} placeholders={placeholders} sample={sample} depth={depth + 1} />
              </BranchCol>
              <BranchCol side="right" label="Нет" color="var(--color-negative)" terminated={terminates(n.no)}>
                <NodeList nodes={n.no} onChange={list => replace(i, { ...n, no: list })} placeholders={placeholders} sample={sample} depth={depth + 1} />
              </BranchCol>
            </div>
          )}
          {n.type === 'end' && nodes[i + 1]?.type !== 'restart' && (
            // После «Завершить» единственное продолжение — «В начало». Без него — точка.
            <div className="flex flex-col items-center">
              <div className="h-3 w-px bg-[var(--color-negative)]" />
              <button type="button" onClick={() => insert(i + 1, makeNode('restart'))} title="После паузы вернуть менеджера под триггер"
                className="min-h-8 inline-flex items-center gap-1.5 rounded-full border border-dashed border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
                <RotateCcw size={12} /> + В начало
              </button>
              <div className="mt-1 h-3 w-3 rounded-full bg-[var(--color-negative)]" title="Окончательно: сценарий для менеджера больше не запустится" />
            </div>
          )}
          {n.type === 'restart' && (
            <div className="flex flex-col items-center" title="После паузы — снова под триггер">
              <div className="h-3 w-px bg-[var(--color-accent)]" />
              <div className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)]"><RotateCcw size={12} /></div>
            </div>
          )}
          {n.type === 'check' && terminates([n]) && (
            <div className="flex flex-col items-center" title="Обе ветки завершены — продолжения нет">
              <div className="h-3 w-px bg-[var(--color-border)]" />
              <div className="h-3 w-3 rounded-full bg-[var(--color-text-muted)]" />
            </div>
          )}
        </div>
      ))}
      {!terminates(nodes) && <AddBetween onAdd={node => insert(nodes.length, node)} last />}
    </div>
  );
}

// Колонка ветки: сверху коннектор от родителя (горизонтальная линия от центра колонки к
// внутреннему краю + вертикальный отвод), подпись ветки, содержимое, снизу — зеркальный
// коннектор слияния. root — ветки триггера: подпись крупнее, с пояснением.
function BranchCol({ side, label, color, hint, root, terminated, children }: {
  side: 'left' | 'right'; label: string; color: string; hint?: string; root?: boolean; terminated?: boolean; children: React.ReactNode;
}) {
  const hline = side === 'left' ? { left: '50%', right: 0 } : { left: 0, right: '50%' };
  return (
    <div className={`flex flex-col items-center ${COL_MIN} px-4 h-full`}>
      <div className="relative h-5 w-full">
        <div className="absolute top-0 h-px" style={{ ...hline, background: color }} />
        <div className="absolute left-1/2 top-0 h-5 w-px" style={{ background: color }} />
      </div>
      <div className={`inline-flex items-center gap-2 rounded-full border px-3 ${root ? 'py-1.5 text-sm' : 'py-0.5 text-[12px]'} font-bold`} style={{ color, borderColor: color }}>
        <ArrowDown size={root ? 14 : 11} /> {label}
      </div>
      {hint && <div className="mt-1 text-[11px] text-[var(--color-text-muted)] text-center max-w-[460px]">{hint}</div>}
      {children}
      {terminated ? (
        // Ветка завершена «Завершить» — в слияние не идёт, просто заканчивается.
        <div className="flex-1" />
      ) : (
        <>
          {/* колонка короче соседней — линия дотягивается до общего слияния */}
          <div className="flex-1 w-px min-h-5 bg-[var(--color-border)]" />
          <div className="relative h-5 w-full">
            <div className="absolute left-1/2 top-0 h-5 w-px bg-[var(--color-border)]" />
            <div className="absolute bottom-0 h-px bg-[var(--color-border)]" style={hline} />
          </div>
        </>
      )}
    </div>
  );
}

function makeNode(type: FlowNode['type']): FlowNode {
  const id = newNodeId();
  switch (type) {
    case 'message': return { id, type, text: '' };
    case 'wait': return { id, type, days: 7 };
    case 'check': return { id, type, condition: 'recovered', yes: [], no: [] };
    case 'end': return { id, type, cooldownDays: null };
    case 'restart': return { id, type };
  }
}

function AddBetween({ onAdd, last }: { onAdd: (n: FlowNode) => void; last?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-center">
      <div className="h-4 w-px bg-[var(--color-border)]" />
      {open ? (
        <div className="flex flex-wrap justify-center gap-1 rounded-xl border border-[var(--color-accent)] bg-[var(--color-bg)] p-1.5">
          {(['message', 'wait', 'check', 'end'] as FlowNode['type'][]).map(t => {
            const { label, Icon } = NODE_META[t];
            return (
              <button key={t} type="button" onClick={() => { onAdd(makeNode(t)); setOpen(false); }}
                className="min-h-9 inline-flex items-center gap-1 rounded-lg px-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"><Icon size={14} /> {label}</button>
            );
          })}
          <button type="button" onClick={() => setOpen(false)} className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X size={14} /></button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} title="Добавить блок"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-full border bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] ${last ? 'border-[var(--color-border)]' : 'border-[var(--color-border)]/60'}`}>
          <Plus size={15} />
        </button>
      )}
      {!last && <div className="h-4 w-px bg-[var(--color-border)]" />}
    </div>
  );
}

function NodeCard({ node, onChange, onRemove, onUp, onDown, placeholders, sample }: {
  node: FlowNode; onChange: (n: FlowNode) => void; onRemove: () => void; onUp?: () => void; onDown?: () => void;
  placeholders: Options['placeholders']; sample: Record<string, string>;
}) {
  const { label, Icon, cls } = NODE_META[node.type];
  return (
    <div className={`${CARD_W} rounded-xl border-l-4 border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm p-4 ${cls}`}>
      <div className="mb-2 flex items-center gap-2">
        <Icon size={16} className="text-[var(--color-text-muted)]" />
        <span className="text-sm font-semibold text-[var(--color-text)]">{label}</span>
        <div className="ml-auto flex items-center">
          <button type="button" onClick={onUp} disabled={!onUp} className="h-9 w-9 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-25" title="Выше"><ArrowUp size={16} /></button>
          <button type="button" onClick={onDown} disabled={!onDown} className="h-9 w-9 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-25" title="Ниже"><ArrowDown size={16} /></button>
          <button type="button" onClick={() => { if (node.type !== 'check' || (node.yes.length + node.no.length === 0) || confirm('Удалить проверку вместе с вложенными блоками?')) onRemove(); }}
            className="h-9 w-9 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-negative)]" title="Удалить"><Trash2 size={16} /></button>
        </div>
      </div>
      {node.type === 'message' && <MessageBody node={node} onChange={onChange} placeholders={placeholders} sample={sample} />}
      {node.type === 'wait' && (
        <div className="flex items-center gap-3 text-base text-[var(--color-text)]">
          <input type="number" inputMode="numeric" min={1} max={180} value={node.days} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange({ ...node, days: v }); }} className={`${inputCls} w-24`} />
          дней, потом — следующий блок
        </div>
      )}
      {node.type === 'check' && (
        <div>
          <select value={node.condition} onChange={e => onChange({ ...node, condition: e.target.value as CheckCondition })} className={inputCls}>
            {(Object.keys(CONDITION_LABEL) as CheckCondition[]).map(c => <option key={c} value={c}>{CONDITION_LABEL[c]}?</option>)}
          </select>
          <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">Показатель считается заново на день проверки. Пустая ветка — цепочка идёт дальше по основной.</div>
        </div>
      )}
      {node.type === 'end' && (
        <div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text)]">
            Цепочка закрыта; пауза
            <input type="number" inputMode="numeric" min={0} max={365} placeholder="из триггера" value={node.cooldownDays ?? ''}
              onChange={e => onChange({ ...node, cooldownDays: e.target.value === '' ? null : Number(e.target.value) })} className={`${inputCls} w-28`} />
            дней
          </div>
          <div className="mt-1.5 text-[12px] text-[var(--color-text-muted)]">
            С блоком «В начало» ниже — после паузы менеджер снова под триггером, цикл повторится. Без него — окончательно,
            сценарий для этого менеджера больше не запустится.
          </div>
        </div>
      )}
      {node.type === 'restart' && (
        <div className="text-sm text-[var(--color-text)]">
          После паузы менеджер возвращается под триггер: если показатель снова ниже порога (или снова в норме) — цикл коучинга запускается заново.
        </div>
      )}
    </div>
  );
}

function MessageBody({ node, onChange, placeholders, sample }: { node: Extract<FlowNode, { type: 'message' }>; onChange: (n: FlowNode) => void; placeholders: Options['placeholders']; sample: Record<string, string> }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [showSample, setShowSample] = useState(false);
  const insert = (key: string) => {
    const el = ref.current; const cur = node.text;
    const start = el?.selectionStart ?? cur.length, end = el?.selectionEnd ?? cur.length;
    onChange({ ...node, text: `${cur.slice(0, start)}{${key}}${cur.slice(end)}` });
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = start + key.length + 2; } });
  };
  return (
    <div>
      <textarea ref={ref} value={node.text} rows={7} onChange={e => onChange({ ...node, text: e.target.value })} placeholder="Текст сообщения менеджеру…"
        className={`${inputCls} resize-y !text-base leading-relaxed`} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
        {placeholders.map(p => (
          <button key={p.key} type="button" title={p.hint} onMouseDown={e => e.preventDefault()} onClick={() => insert(p.key)}
            className="min-h-7 rounded-md border border-[var(--color-border)] px-1.5 font-mono text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">{`{${p.key}}`}</button>
        ))}
        <button type="button" onClick={() => setShowSample(s => !s)} className="ml-auto inline-flex items-center gap-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          {showSample ? <ChevronDown size={11} /> : <ChevronRight size={11} />} пример
        </button>
      </div>
      {showSample && node.text && (
        <div className="mt-2 rounded-lg border border-dashed border-[var(--color-border)] p-3 text-sm leading-relaxed whitespace-pre-wrap break-words text-[var(--color-text)]">{renderTemplate(node.text, sample)}</div>
      )}
    </div>
  );
}

// ── Превью на живых данных ───────────────────────────────────────────────────
const STATUS_META: Record<Eval['status'], { label: string; cls: string }> = {
  no_data: { label: 'нет данных', cls: 'text-[var(--color-text-muted)]' },
  below:   { label: 'ниже порога', cls: 'text-[var(--color-negative)] font-semibold' },
  between: { label: 'в коридоре', cls: 'text-[var(--color-warning)]' },
  norm:    { label: 'в норме', cls: 'text-[var(--color-positive)] font-semibold' },
};
const STEP_TONE: Record<ExecStep['type'], 'pos' | 'neg' | 'warn' | undefined> = { start: undefined, message: 'warn', wait: undefined, check: undefined, end: 'neg', deferred: 'neg' };

function PreviewPanel({ flow, scenarioId, dirty, enabledScenario, fnEnabled, onClose }: {
  flow: ScenarioFlow; scenarioId: string | null; dirty: boolean; enabledScenario: boolean; fnEnabled: boolean | null; onClose: () => void;
}) {
  const preview = useMutation({
    mutationFn: () => fetch('/api/settings/bots/scenarios/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenarioId, flow }),
    }).then(jsonOrThrow) as Promise<Preview>,
  });
  useEffect(() => { preview.mutate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = useMutation({
    mutationFn: (ids?: number[]) => fetch(`/api/settings/bots/scenarios/${scenarioId}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids ? { managerIds: ids } : {}),
    }).then(jsonOrThrow) as Promise<{ summary: RunSummary }>,
    onSuccess: () => preview.mutate(),
  });
  const [onlyActive, setOnlyActive] = useState(true);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const p = preview.data;
  const dt = p?.metric.dataType ?? 'decimal';
  const dp = p?.metric.decimalPlaces ?? 1;
  const rows = useMemo(() => (p?.evals ?? []).filter(e => !onlyActive || e.steps.length > 0), [p, onlyActive]);
  const active = (p?.evals ?? []).filter(e => e.steps.length > 0);
  const canRun = !!scenarioId && !dirty && fnEnabled !== false;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)] inline-flex items-center gap-2"><FlaskConical size={16} /> Проверка на живых данных — что бот сделал бы сегодня</h2>
        <div className="flex items-center gap-1">
          <button className={btnCls} onClick={() => preview.mutate()} disabled={preview.isPending}><FlaskConical size={14} /> Пересчитать</button>
          <button className={btnCls} onClick={onClose}><X size={14} /></button>
        </div>
      </div>
      {preview.isPending && <div className="text-sm text-[var(--color-text-muted)]">Считаю показатель по всем менеджерам… (обычно 5–20 секунд)</div>}
      {preview.isError && <div className="text-sm text-[var(--color-negative)]">{(preview.error as Error).message}</div>}
      {p && (
        <>
          <div className="text-[12px] text-[var(--color-text-muted)]">
            «{p.metric.name}» за {fmtDay(p.window.from)}–{fmtDay(p.window.to)}
            {p.baselineWindow ? <> · база: своё значение за {fmtDay(p.baselineWindow.from)}–{fmtDay(p.baselineWindow.to)}</> : <> · цель {fmtV(flow.trigger.targetValue, dt, dp)}</>}
            {' '}· порог = база − {flow.trigger.dropThreshold.toLocaleString('ru-RU')} {unitFor(dt)}. Считается {dirty ? 'ТЕКУЩИЙ ЧЕРНОВИК' : 'сохранённая версия'}; ничего не отправлено
            {scenarioId ? ', открытые цепочки учтены' : ', цепочек ещё нет (сценарий не сохранён)'}.
          </div>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <Chip>менеджеров {p.summary.managers}</Chip>
            <Chip tone="neg">ниже порога {p.summary.below}</Chip>
            <Chip tone="pos">в норме {p.summary.norm}</Chip>
            <Chip>нет данных {p.summary.noData}</Chip>
            <Chip tone="warn">новых цепочек {p.summary.started}</Chip>
            <Chip>продолжено {p.summary.continued}</Chip>
            <Chip tone="warn">сообщений {p.summary.messages}</Chip>
            <Chip>закрыто {p.summary.closed}</Chip>
            {p.summary.deferred > 0 && <Chip>отложено антиспамом {p.summary.deferred}</Chip>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text)] min-h-11">
              <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              Только те, у кого сегодня что-то происходит ({active.length})
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {!scenarioId && <span className="text-[11px] text-[var(--color-text-muted)]">Запуск — после сохранения</span>}
              {scenarioId && dirty && <span className="text-[11px] text-[var(--color-warning)]">Сохрани изменения, чтобы запустить</span>}
              {fnEnabled === false && <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-warning)]"><AlertTriangle size={12} /> функция выключена — запуск не сработает</span>}
              <button className={btnPrimaryCls} disabled={!canRun || run.isPending || active.length === 0}
                title={enabledScenario ? '' : 'Сценарий выключен — ручной запуск всё равно сработает один раз'}
                onClick={() => { if (confirm(`Запустить по-настоящему: уйдёт ${p.summary.messages} сообщений, цепочки продвинутся. Продолжить?`)) run.mutate(undefined); }}>
                <Play size={14} /> Запустить сейчас
              </button>
            </div>
          </div>
          {run.isError && <div className="text-xs text-[var(--color-negative)]">{(run.error as Error).message}</div>}
          {run.isSuccess && <div className="text-xs text-[var(--color-positive)]">Прогон выполнен: сообщений {run.data.summary.messages}, новых цепочек {run.data.summary.started}, закрыто {run.data.summary.closed}. Ниже — пересчитанное состояние.</div>}
          <div className="scroll-x rounded-xl border border-[var(--color-border)]">
            <table className="w-full text-[12px]">
              <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-2 py-2 text-left">Менеджер</th>
                  <th className="px-2 py-2 text-right">Значение</th>
                  <th className="px-2 py-2 text-right">База</th>
                  <th className="px-2 py-2 text-right">Порог</th>
                  <th className="px-2 py-2 text-right">Δ</th>
                  <th className="px-2 py-2 text-left">Статус</th>
                  <th className="px-2 py-2 text-left">Сегодня</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-center text-[var(--color-text-muted)]">Сегодня ни у кого ничего не происходит.</td></tr>}
                {rows.map(e => {
                  const isOpen = openRow === e.bitrixId;
                  const st = STATUS_META[e.status];
                  return (
                    <RowGroup key={e.bitrixId}>
                      <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] cursor-pointer" onClick={() => setOpenRow(isOpen ? null : e.bitrixId)}>
                        <td className="px-2 py-1.5 font-semibold text-[var(--color-text)] whitespace-nowrap">{e.name}
                          {e.run && <span className="ml-1.5 text-[10px] font-normal text-[var(--color-text-muted)]">цепочка · {e.run.branch === 'below' ? 'просадка' : 'в норме'}</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">{fmtV(e.value, dt, dp)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{fmtV(e.base, dt, dp)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{fmtV(e.threshold, dt, dp)}</td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${e.delta !== null && e.delta < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}`}>{fmtDelta(e.delta, dt)}</td>
                        <td className={`px-2 py-1.5 whitespace-nowrap ${st.cls}`}>{st.label}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-wrap items-center gap-1 min-w-[16rem]">
                            {e.steps.filter(s => s.type !== 'start').map((s, i) => <Chip key={i} tone={STEP_TONE[s.type]}>{s.type === 'check' ? `проверка: ${s.result ? 'да' : 'нет'}` : s.type === 'message' ? 'сообщение' : s.label}</Chip>)}
                            <span className="text-[11px] text-[var(--color-text-muted)]">{e.outcome}</span>
                            {e.steps.length > 0 && (isOpen ? <ChevronDown size={13} className="text-[var(--color-text-muted)]" /> : <ChevronRight size={13} className="text-[var(--color-text-muted)]" />)}
                          </div>
                        </td>
                      </tr>
                      {isOpen && e.steps.length > 0 && (
                        <tr className="border-t border-dashed border-[var(--color-border)] bg-[var(--color-bg)]">
                          <td colSpan={7} className="px-3 py-2">
                            <ol className="flex flex-col gap-1.5 text-[12px]">
                              {e.steps.map((s, i) => (
                                <li key={i} className="flex gap-2">
                                  <span className="shrink-0 w-5 text-right text-[var(--color-text-muted)]">{i + 1}.</span>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[var(--color-text)]">{s.label}</div>
                                    {s.text && <div className="mt-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-2 text-sm whitespace-pre-wrap break-words text-[var(--color-text)]">{s.text}</div>}
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </td>
                        </tr>
                      )}
                    </RowGroup>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
function RowGroup({ children }: { children: React.ReactNode }) { return <>{children}</>; }

// ── Мелочи ───────────────────────────────────────────────────────────────────
function Seg({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`min-h-11 flex-1 rounded-lg border px-3 text-sm transition-colors ${on
        ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
        : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{children}</button>
  );
}
function Num({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className={labelCls}>{label}</div>
      <input type="number" inputMode="numeric" min={min} max={max} value={value}
        onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }} className={inputCls} />
    </div>
  );
}
