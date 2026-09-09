'use client';
// Вкладка «Сценарии» панели бота «Аналитик» — авто-коучинг менеджеров по данным
// (задача владельца 09.09.2026). Движок — lib/jobs/scenarios.ts, тут только
// конструктор правил, превью «что бы бот сказал сегодня» и журнал цепочек.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellOff, Plus, Play, FlaskConical, Pencil, Trash2, X, Search, ChevronRight, ChevronDown, History,
  Target, TrendingDown, MessageSquareText, Sparkles, Clock, Check, AlertTriangle, ArrowRight,
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { formatValue } from '@/lib/format';
import type { DataType } from '@/lib/metrics/types';

// ── Типы ответов API ─────────────────────────────────────────────────────────
interface Scenario {
  id: string; name: string; enabled: boolean; metricId: string; metricName: string; metricDataType: DataType;
  windowDays: number; baseline: 'target' | 'own_avg'; targetValue: number | null; baselineDays: number; dropThreshold: number;
  adviceText: string; followupDays: number; followupImprovedText: string; followupSameText: string; maxSteps: number; cooldownDays: number;
  praiseEnabled: boolean; praiseText: string | null; praiseCooldownDays: number; checkHour: number; weekdaysOnly: boolean;
  lastRunAt: string | null; lastRunSummary: RunSummary | { date: string; error: string } | null;
  stats: { open: number; sent30: number; lastEventAt: string | null };
}
type Kind = 'advice' | 'followup_same' | 'followup_improved' | 'praise';
interface RunSummary { date: string; managers: number; noData: number; below: number; norm: number; sent: Record<Kind, number>; skipped: number; dryPreview?: boolean }
interface MetricOpt { id: string; name: string; short: string | null; category: string | null; dataType: DataType; decimalPlaces: number; description: string | null; formula: string | null }
interface Options { metrics: MetricOpt[]; placeholders: { key: string; hint: string }[] }
interface Eval {
  bitrixId: number; name: string; value: number | null; base: number | null; threshold: number | null; delta: number | null;
  status: 'no_data' | 'below' | 'between' | 'norm'; action: Kind | 'none'; reason: string; text: string | null;
  run: { id: number; step: number; nextCheckAt: string | null; startValue: number | null } | null;
}
interface Preview {
  metric: { id: string; name: string; dataType: DataType; decimalPlaces: number };
  window: { from: string; to: string }; baselineWindow: { from: string; to: string } | null; evals: Eval[]; summary: RunSummary;
}

const cardCls = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4';
const inputCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';
const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';
const labelCls = 'text-[11px] text-[var(--color-text-muted)] mb-1';

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const KIND_META: Record<Kind, { label: string; cls: string }> = {
  advice:            { label: 'совет',          cls: 'bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] text-[var(--color-warning)]' },
  followup_same:     { label: 'всё ещё ниже',   cls: 'bg-[color-mix(in_srgb,var(--color-negative)_16%,transparent)] text-[var(--color-negative)]' },
  followup_improved: { label: 'стало лучше 🎉', cls: 'bg-[color-mix(in_srgb,var(--color-positive)_18%,transparent)] text-[var(--color-positive)]' },
  praise:            { label: 'похвала',        cls: 'bg-[color-mix(in_srgb,var(--color-positive)_18%,transparent)] text-[var(--color-positive)]' },
};
const STATUS_META: Record<Eval['status'], { label: string; cls: string }> = {
  no_data: { label: 'нет данных', cls: 'text-[var(--color-text-muted)]' },
  below:   { label: 'ниже порога', cls: 'text-[var(--color-negative)] font-semibold' },
  between: { label: 'в коридоре', cls: 'text-[var(--color-warning)]' },
  norm:    { label: 'в норме', cls: 'text-[var(--color-positive)] font-semibold' },
};

const unitFor = (dt: DataType) => (dt === 'percent' ? 'п.п.' : dt === 'money' ? '₽' : dt === 'months' ? 'мес.' : '');
const fmtV = (v: number | null, dt: DataType, dp = 1) => formatValue(v, dt, dt === 'int' ? 0 : dp);
const fmtDelta = (d: number | null, dt: DataType) => {
  if (d === null) return '—';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return dt === 'percent' ? `${sign}${Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.п.` : `${sign}${fmtV(Math.abs(d), dt)}`;
};
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtDay = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('.');

// ── Вкладка ──────────────────────────────────────────────────────────────────
export function ScenariosTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ scenarios: Scenario[] }>({
    queryKey: ['bot-scenarios'],
    queryFn: () => fetch('/api/settings/bots/scenarios').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const { data: opts } = useQuery<Options>({
    queryKey: ['bot-scenario-options'],
    queryFn: () => fetch('/api/settings/bots/scenarios/options').then(jsonOrThrow),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  const { data: fns } = useQuery<{ functions: { key: string; enabled: boolean }[] }>({
    queryKey: ['bot-functions'],
    queryFn: () => fetch('/api/settings/bots/channels').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const fnEnabled = fns?.functions.find(f => f.key === 'scenarios')?.enabled ?? null;
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['bot-scenarios'] });

  const [editing, setEditing] = useState<Scenario | 'new' | null>(null);
  const [previewOf, setPreviewOf] = useState<Scenario | null>(null);
  const [journalOf, setJournalOf] = useState<Scenario | null>(null);

  const toggle = useMutation({
    mutationFn: (s: Scenario) => fetch('/api/settings/bots/scenarios', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, enabled: !s.enabled }),
    }).then(jsonOrThrow),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => fetch(`/api/settings/bots/scenarios?id=${id}`, { method: 'DELETE' }).then(jsonOrThrow),
    onSuccess: invalidate,
  });

  return (
    <div className="flex flex-col gap-4">
      <HowItWorks fnEnabled={fnEnabled} />

      <section className={cardCls}>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-base font-bold text-[var(--color-text)] inline-flex items-center gap-2"><Sparkles size={16} /> Сценарии</h2>
            <span className="text-xs text-[var(--color-text-muted)]">{data ? `${data.scenarios.length} шт. · включено ${data.scenarios.filter(s => s.enabled).length}` : ''}</span>
          </div>
          <button className={btnPrimaryCls} onClick={() => setEditing('new')} disabled={!opts}><Plus size={14} /> Новый сценарий</button>
        </div>

        {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
        {data && data.scenarios.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
            Сценариев пока нет. Начните с «Конверсия в продажу, цель 15%» — шаблон уже заполнен в форме.
          </div>
        )}
        <div className="flex flex-col gap-2">
          {data?.scenarios.map(s => (
            <ScenarioCard key={s.id} s={s}
              onToggle={() => toggle.mutate(s)} onEdit={() => setEditing(s)} onPreview={() => setPreviewOf(s)}
              onJournal={() => setJournalOf(s)}
              onDelete={() => { if (confirm(`Удалить сценарий «${s.name}»? История цепочек и сообщений тоже удалится.`)) remove.mutate(s.id); }} />
          ))}
        </div>
        {(toggle.isError || remove.isError) && <div className="mt-2 text-xs text-[var(--color-negative)]">{((toggle.error ?? remove.error) as Error)?.message}</div>}
      </section>

      {editing && opts && (
        <ScenarioForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? null : editing} options={opts}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />
      )}
      {previewOf && <PreviewModal s={previewOf} fnEnabled={fnEnabled} onClose={() => { setPreviewOf(null); invalidate(); }} />}
      {journalOf && <JournalModal s={journalOf} onClose={() => setJournalOf(null)} />}
    </div>
  );
}

function HowItWorks({ fnEnabled }: { fnEnabled: boolean | null }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={cardCls}>
      <button onClick={() => setOpen(o => !o)} className="w-full min-h-11 flex items-center justify-between gap-2 text-left">
        <span className="text-sm font-semibold text-[var(--color-text)] inline-flex items-center gap-2">
          <Target size={15} /> Как бот коучит по сценарию
        </span>
        <span className="inline-flex items-center gap-3">
          {fnEnabled === false && (
            <span className="inline-flex items-center gap-1 rounded-md bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] px-2 py-0.5 text-[11px] text-[var(--color-warning)]">
              <BellOff size={11} /> функция «Сценарии коучинга» выключена — ничего не уйдёт
            </span>
          )}
          {open ? <ChevronDown size={16} className="text-[var(--color-text-muted)]" /> : <ChevronRight size={16} className="text-[var(--color-text-muted)]" />}
        </span>
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3 text-[12px] leading-snug text-[var(--color-text)]">
          <Step n={1} icon={<Target size={14} />} title="Показатель и цель">
            Любая метрика каталога, считается на каждого менеджера за окно (например, 30 дней до вчера). База — фиксированная цель
            или собственное значение менеджера за предыдущие N дней («упал относительно себя»).
          </Step>
          <Step n={2} icon={<TrendingDown size={14} />} title="Просадка → совет">
            Ниже базы больше, чем на допустимую просадку, — бот пишет совет и назначает проверку через M дней. Одна цепочка на
            менеджера, не больше одного сообщения сценариев в день.
          </Step>
          <Step n={3} icon={<MessageSquareText size={14} />} title="Проверка">
            В день проверки: вышел на порог — «Молодец!» и цепочка закрыта; всё ещё ниже — повторный совет (до лимита шагов),
            потом пауза по этому менеджеру.
          </Step>
          <Step n={4} icon={<Sparkles size={14} />} title="Похвала">
            Кто на уровне цели или выше — получает похвалу, не чаще заданного интервала. Неактивные аккаунты и отказавшиеся
            от бота — не трогаем.
          </Step>
        </div>
      )}
    </section>
  );
}
function Step({ n, icon, title, children }: { n: number; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3">
      <div className="mb-1 flex items-center gap-2 font-semibold">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-accent)] text-[10px] text-[var(--color-text-inverse)]">{n}</span>
        {icon} {title}
      </div>
      <div className="text-[var(--color-text-muted)]">{children}</div>
    </div>
  );
}

// ── Карточка сценария ────────────────────────────────────────────────────────
function ScenarioCard({ s, onToggle, onEdit, onPreview, onJournal, onDelete }: {
  s: Scenario; onToggle: () => void; onEdit: () => void; onPreview: () => void; onJournal: () => void; onDelete: () => void;
}) {
  const dt = s.metricDataType;
  const unit = unitFor(dt);
  const base = s.baseline === 'target' ? `цель ${fmtV(s.targetValue, dt)}` : `своё среднее за ${s.baselineDays} дн.`;
  const sum = s.lastRunSummary;
  const isErr = sum && 'error' in sum;
  return (
    <div className={`rounded-xl border p-3 ${s.enabled ? 'border-[var(--color-border)]' : 'border-dashed border-[var(--color-border)] opacity-80'}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={s.enabled} onChange={onToggle} title={s.enabled ? 'Выключить (открытые цепочки закроются)' : 'Включить'}
          className="tap-target mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-bold text-[var(--color-text)]">{s.name}</span>
            {!s.enabled && <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><BellOff size={11} /> выключен</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
            <Chip><Target size={11} /> {s.metricName} · {s.windowDays} дн.</Chip>
            <Chip>{base}</Chip>
            <Chip><TrendingDown size={11} /> просадка &gt; {s.dropThreshold.toLocaleString('ru-RU')} {unit}</Chip>
            <Chip><Clock size={11} /> проверка через {s.followupDays} дн. · до {s.maxSteps} сов. · пауза {s.cooldownDays} дн.</Chip>
            <Chip><Sparkles size={11} /> {s.praiseEnabled ? `похвала раз в ${s.praiseCooldownDays} дн.` : 'без похвалы'}</Chip>
            <Chip>{String(s.checkHour).padStart(2, '0')}:00 МСК{s.weekdaysOnly ? ', будни' : ', ежедневно'}</Chip>
          </div>
          <div className="mt-1.5 text-[10.5px] text-[var(--color-text-muted)]">
            открытых цепочек <b className="text-[var(--color-text)]">{s.stats.open}</b> · за 30 дней отправлено <b className="text-[var(--color-text)]">{s.stats.sent30}</b>
            {s.lastRunAt && (
              <> · прогон {fmtDate(s.lastRunAt)}{sum && !isErr && ` — менеджеров ${(sum as RunSummary).managers}, ниже порога ${(sum as RunSummary).below}, советов ${(sum as RunSummary).sent.advice}, проверок ${(sum as RunSummary).sent.followup_same + (sum as RunSummary).sent.followup_improved}, похвал ${(sum as RunSummary).sent.praise}`}</>
            )}
            {isErr && <span className="text-[var(--color-negative)]"> · ошибка: {(sum as { error: string }).error}</span>}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={onPreview} title="Проверить сейчас (без отправки)" className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><FlaskConical size={15} /></button>
          <button onClick={onJournal} title="Журнал цепочек и сообщений" className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><History size={15} /></button>
          <button onClick={onEdit} title="Изменить" className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><Pencil size={15} /></button>
          <button onClick={onDelete} title="Удалить" className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"><Trash2 size={15} /></button>
        </div>
      </div>
    </div>
  );
}
function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-hover)] px-2 py-0.5 text-[var(--color-text)]">{children}</span>;
}

// ── Форма ────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  name: 'Конверсия в продажу — цель 15%',
  windowDays: 30, baseline: 'target' as 'target' | 'own_avg', targetValue: '15', baselineDays: 90, dropThreshold: '2',
  adviceText: '{имя}, привет! Смотрю на твой показатель «{показатель}» за последние {окно} дней: {значение} при цели {цель} ({дельта}).\n\nДавай подтянем: пройдись по всем открытым броням и отзвонись каждому, у кого не было касания больше 3 дней — обычно это самая быстрая точка роста конверсии. Вернусь через {дней} дней — посмотрим, что изменилось.',
  followupDays: 7,
  followupSameText: '{имя}, проверяю, как договаривались. «{показатель}» — {значение}, всё ещё ниже порога {порог} (в начале было {было}).\n\nПосмотри, все ли брони прозвонены и по каждой ли назначен следующий шаг. Если что-то мешает — напиши мне в ответ, разберём. Проверю ещё через {дней} дней.',
  followupImprovedText: '{имя}, молодец! «{показатель}» поднялся до {значение} (было {было}) — вышел на порог {порог}. Так держать! 💪',
  maxSteps: 2, cooldownDays: 14,
  praiseEnabled: true, praiseCooldownDays: 14,
  praiseText: '{имя}, «{показатель}» за последние {окно} дней — {значение}: на уровне цели {цель} или выше. Отличная работа, так и продолжай! 🔥',
  checkHour: 10, weekdaysOnly: true,
};

type Form = {
  name: string; metricId: string; windowDays: number; baseline: 'target' | 'own_avg'; targetValue: string; baselineDays: number;
  dropThreshold: string; adviceText: string; followupDays: number; followupSameText: string; followupImprovedText: string;
  maxSteps: number; cooldownDays: number; praiseEnabled: boolean; praiseText: string; praiseCooldownDays: number; checkHour: number; weekdaysOnly: boolean;
};

function ScenarioForm({ initial, options, onClose, onSaved }: { initial: Scenario | null; options: Options; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(() => initial ? {
    name: initial.name, metricId: initial.metricId, windowDays: initial.windowDays, baseline: initial.baseline,
    targetValue: initial.targetValue === null ? '' : String(initial.targetValue), baselineDays: initial.baselineDays,
    dropThreshold: String(initial.dropThreshold), adviceText: initial.adviceText, followupDays: initial.followupDays,
    followupSameText: initial.followupSameText, followupImprovedText: initial.followupImprovedText, maxSteps: initial.maxSteps,
    cooldownDays: initial.cooldownDays, praiseEnabled: initial.praiseEnabled, praiseText: initial.praiseText ?? '',
    praiseCooldownDays: initial.praiseCooldownDays, checkHour: initial.checkHour, weekdaysOnly: initial.weekdaysOnly,
  } : {
    ...DEFAULTS,
    metricId: (options.metrics.find(m => m.id === 'cr_deal_to_sale_all') ?? options.metrics.find(m => /^CR Сделка → Продажа/i.test(m.name)))?.id ?? '',
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF(p => ({ ...p, [k]: v }));
  const metric = options.metrics.find(m => m.id === f.metricId) ?? null;
  const dt: DataType = metric?.dataType ?? 'decimal';
  const unit = unitFor(dt);
  const lastTextarea = useRef<HTMLTextAreaElement | null>(null);

  const save = useMutation({
    mutationFn: () => fetch('/api/settings/bots/scenarios', {
      method: initial ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(initial ? { id: initial.id } : {}), ...f }),
    }).then(jsonOrThrow),
    onSuccess: onSaved,
  });

  // Живой пример: как выглядит совет с подставленными цифрами.
  const sample = useMemo(() => {
    const base = f.baseline === 'target' ? Number(f.targetValue.replace(',', '.')) : (dt === 'percent' ? 14.2 : 100);
    const drop = Number(f.dropThreshold.replace(',', '.')) || 0;
    const val = Number.isFinite(base) ? base - drop - (dt === 'percent' ? 1.3 : Math.max(1, base * 0.1)) : null;
    const ctx: Record<string, string> = {
      'имя': 'Иван', 'показатель': metric?.name ?? 'показатель', 'значение': fmtV(val, dt, metric?.decimalPlaces ?? 1),
      'цель': fmtV(Number.isFinite(base) ? base : null, dt, metric?.decimalPlaces ?? 1),
      'порог': fmtV(Number.isFinite(base) ? base - drop : null, dt, metric?.decimalPlaces ?? 1),
      'дельта': fmtDelta(val !== null && Number.isFinite(base) ? val - base : null, dt),
      'было': fmtV(val, dt, metric?.decimalPlaces ?? 1), 'окно': String(f.windowDays), 'дней': String(f.followupDays),
    };
    return f.adviceText.replace(/\{\s*([^}]+?)\s*\}/g, (m, k: string) => ctx[k.toLowerCase()] ?? m);
  }, [f, metric, dt]);

  const insertPlaceholder = (key: string) => {
    const el = lastTextarea.current;
    if (!el) return;
    const field = el.dataset.field as keyof Form | undefined;
    if (!field) return;
    const cur = String(f[field] ?? '');
    const start = el.selectionStart ?? cur.length, end = el.selectionEnd ?? cur.length;
    const next = `${cur.slice(0, start)}{${key}}${cur.slice(end)}`;
    set(field, next as never);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + key.length + 2; });
  };

  const valid = f.name.trim() && f.metricId && f.adviceText.trim() && f.followupSameText.trim() && f.followupImprovedText.trim()
    && (f.baseline === 'own_avg' || f.targetValue.trim() !== '') && (!f.praiseEnabled || f.praiseText.trim());

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={initial ? `Сценарий «${initial.name}»` : 'Новый сценарий'} desktopWidth="sm:max-w-3xl" bodyClassName="p-0">
      <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto overflow-x-hidden p-4 flex flex-col gap-5">
        <div>
          <div className={labelCls}>Название</div>
          <input value={f.name} onChange={e => set('name', e.target.value)} className={inputCls} />
        </div>

        {/* 1. Показатель */}
        <Section n={1} title="Показатель" icon={<Target size={14} />}>
          <MetricPicker metrics={options.metrics} value={f.metricId} onChange={id => set('metricId', id)} />
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <NumField label="Окно, дней (до вчера)" value={f.windowDays} min={1} max={365} onChange={v => set('windowDays', v)} />
            <div className="sm:col-span-2">
              <div className={labelCls}>База сравнения</div>
              <div className="flex flex-wrap gap-1.5">
                <Seg on={f.baseline === 'target'} onClick={() => set('baseline', 'target')}>Фиксированная цель</Seg>
                <Seg on={f.baseline === 'own_avg'} onClick={() => set('baseline', 'own_avg')}>Своё среднее менеджера</Seg>
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {f.baseline === 'target' ? (
              <TextNum label={`Целевое значение${unit ? `, ${dt === 'percent' ? '%' : unit}` : ''}`} value={f.targetValue} onChange={v => set('targetValue', v)} placeholder={dt === 'percent' ? '15' : '0'} />
            ) : (
              <NumField label="Своё среднее за, дней (до окна)" value={f.baselineDays} min={7} max={730} onChange={v => set('baselineDays', v)} />
            )}
            <TextNum label={`Допустимая просадка${unit ? `, ${unit}` : ''}`} value={f.dropThreshold} onChange={v => set('dropThreshold', v)} placeholder="2" />
            <div className="text-[11px] leading-snug text-[var(--color-text-muted)] self-end pb-2">
              Совет уходит, когда значение ниже базы больше, чем на просадку. Похвала — когда на уровне базы или выше. Между — тишина.
            </div>
          </div>
        </Section>

        {/* 2. Цепочка */}
        <Section n={2} title="Цепочка: совет → проверка" icon={<MessageSquareText size={14} />}>
          <Placeholders items={options.placeholders} onPick={insertPlaceholder} />
          <TextArea label="Совет (первое сообщение при просадке)" field="adviceText" value={f.adviceText} onChange={v => set('adviceText', v)} refCb={lastTextarea} rows={5} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
            <NumField label="Проверка через, дней" value={f.followupDays} min={1} max={90} onChange={v => set('followupDays', v)} />
            <NumField label="Максимум советов в цепочке" value={f.maxSteps} min={1} max={10} onChange={v => set('maxSteps', v)} />
            <NumField label="Пауза после цепочки, дней" value={f.cooldownDays} min={0} max={365} onChange={v => set('cooldownDays', v)} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <TextArea label="Проверка: всё ещё ниже порога (повторный совет)" field="followupSameText" value={f.followupSameText} onChange={v => set('followupSameText', v)} refCb={lastTextarea} rows={5} />
            <TextArea label="Проверка: вышел на порог (похвалить, закрыть цепочку)" field="followupImprovedText" value={f.followupImprovedText} onChange={v => set('followupImprovedText', v)} refCb={lastTextarea} rows={5} />
          </div>
        </Section>

        {/* 3. Похвала */}
        <Section n={3} title="Похвала тем, кто в норме" icon={<Sparkles size={14} />}>
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text)] min-h-11">
              <input type="checkbox" checked={f.praiseEnabled} onChange={e => set('praiseEnabled', e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              Хвалить, если показатель на уровне цели или выше
            </label>
            {f.praiseEnabled && <NumField label="Не чаще, дней" value={f.praiseCooldownDays} min={1} max={365} onChange={v => set('praiseCooldownDays', v)} compact />}
          </div>
          {f.praiseEnabled && <TextArea label="Текст похвалы" field="praiseText" value={f.praiseText} onChange={v => set('praiseText', v)} refCb={lastTextarea} rows={3} />}
        </Section>

        {/* 4. Когда */}
        <Section n={4} title="Когда проверять" icon={<Clock size={14} />}>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className={labelCls}>Час (МСК)</div>
              <select value={f.checkHour} onChange={e => set('checkHour', Number(e.target.value))} className={`${inputCls} w-28`}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text)] min-h-11">
              <input type="checkbox" checked={f.weekdaysOnly} onChange={e => set('weekdaysOnly', e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              Только по будням
            </label>
          </div>
        </Section>

        {/* Пример */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Так будет выглядеть совет (цифры для примера)</div>
          <div className="text-sm whitespace-pre-wrap break-words text-[var(--color-text)]">{sample}</div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <button className={btnPrimaryCls} disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            <Check size={14} /> {initial ? 'Сохранить' : 'Создать (выключенным)'}
          </button>
          <button className={btnCls} onClick={onClose}>Отмена</button>
          {save.isError && <span className="text-xs text-[var(--color-negative)]">{(save.error as Error).message}</span>}
        </div>
      </div>
    </Modal>
  );
}

function Section({ n, title, icon, children }: { n: number; title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-accent)] text-[10px] text-[var(--color-text-inverse)]">{n}</span>
        {icon} {title}
      </div>
      {children}
    </section>
  );
}
function Seg({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`min-h-11 rounded-lg border px-3 text-sm transition-colors ${on
        ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
        : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{children}</button>
  );
}
function NumField({ label, value, min, max, onChange, compact }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; compact?: boolean }) {
  return (
    <div>
      <div className={labelCls}>{label}</div>
      <input type="number" inputMode="numeric" min={min} max={max} value={value}
        onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }}
        className={`${inputCls} ${compact ? 'w-28' : ''}`} />
    </div>
  );
}
function TextNum({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <div className={labelCls}>{label}</div>
      <input inputMode="decimal" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={inputCls} />
    </div>
  );
}
function TextArea({ label, field, value, onChange, refCb, rows }: {
  label: string; field: keyof Form; value: string; onChange: (v: string) => void; refCb: React.MutableRefObject<HTMLTextAreaElement | null>; rows: number;
}) {
  return (
    <div className="mt-2">
      <div className={labelCls}>{label}</div>
      <textarea data-field={field} value={value} rows={rows} onChange={e => onChange(e.target.value)}
        onFocus={e => { refCb.current = e.currentTarget; }}
        className={`${inputCls} resize-y leading-snug`} />
    </div>
  );
}
function Placeholders({ items, onPick }: { items: { key: string; hint: string }[]; onPick: (k: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      <span className="text-[var(--color-text-muted)] mr-1">Подстановки (клик — вставить в поле, где стоит курсор):</span>
      {items.map(p => (
        <button key={p.key} type="button" title={p.hint} onMouseDown={e => e.preventDefault()} onClick={() => onPick(p.key)}
          className="min-h-7 rounded-md border border-[var(--color-border)] px-1.5 font-mono text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          {`{${p.key}}`}
        </button>
      ))}
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
  useEffect(() => { if (!value) setOpen(true); }, [value]);
  return (
    <div>
      <div className={labelCls}>Метрика из каталога</div>
      {chosen && !open ? (
        <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1"><b className="text-[var(--color-text)]">{chosen.name}</b>
              <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">{chosen.category ?? ''} · {chosen.dataType}</span></span>
            <button type="button" onClick={() => setOpen(true)} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><Pencil size={14} /></button>
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

// ── Превью «что бы бот сказал сегодня» ───────────────────────────────────────
function PreviewModal({ s, fnEnabled, onClose }: { s: Scenario; fnEnabled: boolean | null; onClose: () => void }) {
  const preview = useMutation({
    mutationFn: () => fetch(`/api/settings/bots/scenarios/${s.id}/preview`, { method: 'POST' }).then(jsonOrThrow) as Promise<Preview>,
  });
  useEffect(() => { preview.mutate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [onlyActions, setOnlyActions] = useState(true);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const run = useMutation({
    mutationFn: (ids: number[] | undefined) => fetch(`/api/settings/bots/scenarios/${s.id}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids ? { managerIds: ids } : {}),
    }).then(jsonOrThrow) as Promise<{ summary: RunSummary }>,
    onSuccess: () => preview.mutate(),
  });
  const p = preview.data;
  const dt = p?.metric.dataType ?? s.metricDataType;
  const dp = p?.metric.decimalPlaces ?? 1;
  const rows = useMemo(() => (p?.evals ?? []).filter(e => !onlyActions || e.action !== 'none'), [p, onlyActions]);
  const actionable = (p?.evals ?? []).filter(e => e.action !== 'none');

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={<span className="inline-flex items-center gap-2"><FlaskConical size={16} /> Проверка: «{s.name}»</span>} desktopWidth="sm:max-w-4xl" bodyClassName="p-0">
      <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto overflow-x-hidden p-4 flex flex-col gap-3">
        {preview.isPending && <div className="text-sm text-[var(--color-text-muted)]">Считаю показатель по всем менеджерам… (обычно 5–20 секунд)</div>}
        {preview.isError && <div className="text-sm text-[var(--color-negative)]">{(preview.error as Error).message}</div>}
        {p && (
          <>
            <div className="text-[12px] text-[var(--color-text-muted)]">
              «{p.metric.name}» за {fmtDay(p.window.from)}–{fmtDay(p.window.to)}
              {p.baselineWindow && <> · база: своё значение за {fmtDay(p.baselineWindow.from)}–{fmtDay(p.baselineWindow.to)}</>}
              {!p.baselineWindow && <> · цель {fmtV(s.targetValue, dt, dp)}</>} · порог = база − {s.dropThreshold.toLocaleString('ru-RU')} {unitFor(dt)}.
              Ничего не отправлено — это расчёт «что бы бот сделал сегодня».
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <Chip>менеджеров {p.summary.managers}</Chip>
              <Chip><span className="text-[var(--color-negative)]">ниже порога {p.summary.below}</span></Chip>
              <Chip><span className="text-[var(--color-positive)]">в норме {p.summary.norm}</span></Chip>
              <Chip>нет данных {p.summary.noData}</Chip>
              <Chip>советов {p.summary.sent.advice}</Chip>
              <Chip>проверок {p.summary.sent.followup_same + p.summary.sent.followup_improved}</Chip>
              <Chip>похвал {p.summary.sent.praise}</Chip>
              {p.summary.skipped > 0 && <Chip>отложено антиспамом {p.summary.skipped}</Chip>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text)] min-h-11">
                <input type="checkbox" checked={onlyActions} onChange={e => setOnlyActions(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
                Только те, кому бот что-то напишет ({actionable.length})
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {fnEnabled === false && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-warning)]"><AlertTriangle size={12} /> функция выключена — запуск не сработает</span>
                )}
                {selected.size > 0 && (
                  <button className={btnCls} disabled={run.isPending} onClick={() => { if (confirm(`Отправить ${selected.size} сообщений выбранным менеджерам?`)) run.mutate([...selected]); }}>
                    <Play size={14} /> Отправить выбранным ({selected.size})
                  </button>
                )}
                <button className={btnPrimaryCls} disabled={run.isPending || actionable.length === 0}
                  onClick={() => { if (confirm(`Запустить сценарий по-настоящему: уйдёт ${actionable.length} сообщений, цепочки продвинутся. Продолжить?`)) run.mutate(undefined); }}>
                  <Play size={14} /> Запустить сейчас
                </button>
              </div>
            </div>
            {run.isError && <div className="text-xs text-[var(--color-negative)]">{(run.error as Error).message}</div>}
            {run.isSuccess && (
              <div className="text-xs text-[var(--color-positive)]">
                Прогон выполнен: советов {run.data.summary.sent.advice}, проверок {run.data.summary.sent.followup_same + run.data.summary.sent.followup_improved}, похвал {run.data.summary.sent.praise}. Ниже — пересчитанное состояние.
              </div>
            )}
            <div className="scroll-x rounded-xl border border-[var(--color-border)]">
              <table className="w-full text-[12px]">
                <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  <tr>
                    <th className="px-2 py-2 text-left w-8"></th>
                    <th className="px-2 py-2 text-left">Менеджер</th>
                    <th className="px-2 py-2 text-right">Значение</th>
                    <th className="px-2 py-2 text-right">База</th>
                    <th className="px-2 py-2 text-right">Порог</th>
                    <th className="px-2 py-2 text-right">Δ к базе</th>
                    <th className="px-2 py-2 text-left">Статус</th>
                    <th className="px-2 py-2 text-left">Бот сделает</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-4 text-center text-[var(--color-text-muted)]">Сегодня никому ничего не отправится.</td></tr>}
                  {rows.map(e => {
                    const isOpen = openRow === e.bitrixId;
                    const st = STATUS_META[e.status];
                    return (
                      <FragmentRow key={e.bitrixId}>
                        <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] cursor-pointer" onClick={() => setOpenRow(isOpen ? null : e.bitrixId)}>
                          <td className="px-2 py-1.5" onClick={ev => ev.stopPropagation()}>
                            {e.action !== 'none' && (
                              <input type="checkbox" checked={selected.has(e.bitrixId)} className="tap-target h-4 w-4 accent-[var(--color-accent)]"
                                onChange={() => setSelected(prev => { const n = new Set(prev); if (n.has(e.bitrixId)) n.delete(e.bitrixId); else n.add(e.bitrixId); return n; })} />
                            )}
                          </td>
                          <td className="px-2 py-1.5 font-semibold text-[var(--color-text)] whitespace-nowrap">{e.name}
                            {e.run && <span className="ml-1.5 text-[10px] font-normal text-[var(--color-text-muted)]">цепочка · шаг {e.run.step}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">{fmtV(e.value, dt, dp)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{fmtV(e.base, dt, dp)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">{fmtV(e.threshold, dt, dp)}</td>
                          <td className={`px-2 py-1.5 text-right tabular-nums ${e.delta !== null && e.delta < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}`}>{fmtDelta(e.delta, dt)}</td>
                          <td className={`px-2 py-1.5 whitespace-nowrap ${st.cls}`}>{st.label}</td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1.5 min-w-[14rem]">
                              {e.action !== 'none'
                                ? <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] ${KIND_META[e.action].cls}`}>{KIND_META[e.action].label}</span>
                                : <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">ничего</span>}
                              <span className="text-[11px] text-[var(--color-text-muted)] line-clamp-1">{e.reason}</span>
                              {e.text && (isOpen ? <ChevronDown size={13} className="shrink-0 text-[var(--color-text-muted)]" /> : <ChevronRight size={13} className="shrink-0 text-[var(--color-text-muted)]" />)}
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-t border-dashed border-[var(--color-border)] bg-[var(--color-bg)]">
                            <td colSpan={8} className="px-3 py-2">
                              <div className="text-[11px] text-[var(--color-text-muted)] mb-1">{e.reason}</div>
                              {e.text
                                ? <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-2 text-sm whitespace-pre-wrap break-words text-[var(--color-text)]">{e.text}</div>
                                : <div className="text-[11px] text-[var(--color-text-muted)]">Сообщения нет.</div>}
                            </td>
                          </tr>
                        )}
                      </FragmentRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="flex gap-2">
          <button className={btnCls} onClick={() => preview.mutate()} disabled={preview.isPending}><FlaskConical size={14} /> Пересчитать</button>
          <button className={btnCls} onClick={onClose}><X size={14} /> Закрыть</button>
        </div>
      </div>
    </Modal>
  );
}
function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</>; }

// ── Журнал сценария ──────────────────────────────────────────────────────────
interface RunRow { id: string; bitrixId: number; name: string; status: string; step: number; startValue: number | null; lastValue: number | null; nextCheckAt: string | null; createdAt: string; closedAt: string | null; closedReason: string | null }
interface EventRow { id: string; bitrixId: number; name: string; kind: Kind; value: number | null; threshold: number | null; text: string; createdAt: string }
const CLOSE_LABEL: Record<string, string> = { improved: 'вышел на порог', max_steps: 'шаги исчерпаны', disabled: 'сценарий выключили', manual: 'закрыто вручную' };

function JournalModal({ s, onClose }: { s: Scenario; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ runs: RunRow[]; events: EventRow[] }>({
    queryKey: ['bot-scenario-events', s.id],
    queryFn: () => fetch(`/api/settings/bots/scenarios/${s.id}/events`).then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const [openEv, setOpenEv] = useState<string | null>(null);
  const dt = s.metricDataType;
  const open = data?.runs.filter(r => r.status === 'open') ?? [];
  const closed = data?.runs.filter(r => r.status !== 'open') ?? [];
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={<span className="inline-flex items-center gap-2"><History size={16} /> Журнал: «{s.name}»</span>} desktopWidth="sm:max-w-3xl" bodyClassName="p-0">
      <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto overflow-x-hidden p-4 flex flex-col gap-4">
        {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
        {data && (
          <>
            <div>
              <div className="mb-1 text-sm font-semibold text-[var(--color-text)]">Открытые цепочки ({open.length})</div>
              {open.length === 0 ? <div className="text-[12px] text-[var(--color-text-muted)]">Нет — никто сейчас не «на карандаше».</div> : (
                <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
                  {open.map(r => (
                    <div key={r.id} className="px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px]">
                      <span className="font-semibold text-[var(--color-text)]">{r.name}</span>
                      <span className="text-[var(--color-text-muted)]">шаг {r.step}/{s.maxSteps}</span>
                      <span className="text-[var(--color-text-muted)]">старт {fmtV(r.startValue, dt)} <ArrowRight size={10} className="inline" /> сейчас {fmtV(r.lastValue, dt)}</span>
                      <span className="text-[var(--color-text-muted)]">с {fmtDate(r.createdAt)}</span>
                      {r.nextCheckAt && <span className="text-[var(--color-accent)]">проверка {fmtDay(r.nextCheckAt)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1 text-sm font-semibold text-[var(--color-text)]">Отправленные сообщения ({data.events.length})</div>
              {data.events.length === 0 ? <div className="text-[12px] text-[var(--color-text-muted)]">Пока ничего не отправлялось.</div> : (
                <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
                  {data.events.map(e => {
                    const isOpen = openEv === e.id;
                    return (
                      <div key={e.id} className="px-3 py-2 text-[12px]">
                        <button onClick={() => setOpenEv(isOpen ? null : e.id)} className="w-full min-h-8 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-left">
                          <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{fmtDate(e.createdAt)}</span>
                          <span className="font-semibold text-[var(--color-text)]">{e.name}</span>
                          <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] ${KIND_META[e.kind].cls}`}>{KIND_META[e.kind].label}</span>
                          <span className="text-[var(--color-text-muted)]">{fmtV(e.value, dt)}{e.threshold !== null && ` · порог ${fmtV(e.threshold, dt)}`}</span>
                          {isOpen ? <ChevronDown size={13} className="ml-auto text-[var(--color-text-muted)]" /> : <ChevronRight size={13} className="ml-auto text-[var(--color-text-muted)]" />}
                        </button>
                        {isOpen && <div className="mt-1 rounded-lg bg-[var(--color-bg)] p-2 text-sm whitespace-pre-wrap break-words text-[var(--color-text)]">{e.text}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {closed.length > 0 && (
              <div>
                <div className="mb-1 text-sm font-semibold text-[var(--color-text)]">Закрытые цепочки ({closed.length})</div>
                <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
                  {closed.slice(0, 50).map(r => (
                    <div key={r.id} className="px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px]">
                      <span className="font-semibold text-[var(--color-text)]">{r.name}</span>
                      <span className="text-[var(--color-text-muted)]">{fmtV(r.startValue, dt)} <ArrowRight size={10} className="inline" /> {fmtV(r.lastValue, dt)}</span>
                      <span className="text-[var(--color-text-muted)]">{fmtDate(r.createdAt)} — {fmtDate(r.closedAt)}</span>
                      <span className={r.closedReason === 'improved' ? 'text-[var(--color-positive)]' : 'text-[var(--color-text-muted)]'}>{CLOSE_LABEL[r.closedReason ?? ''] ?? r.closedReason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <div><button className={btnCls} onClick={onClose}><X size={14} /> Закрыть</button></div>
      </div>
    </Modal>
  );
}
