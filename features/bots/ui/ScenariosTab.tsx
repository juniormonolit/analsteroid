'use client';
// Вкладка «Сценарии» панели бота «Аналитик» — список сценариев авто-коучинга.
// Сам конструктор (дерево блоков) — отдельная страница ScenarioEditor
// (/settings/bots/analitik/scenarios/[id]), решение владельца 09.09: «не в попапе».
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Plus, Trash2, History, Target, TrendingDown, Sparkles, Clock, ChevronRight, GitBranch } from 'lucide-react';
import { formatValue } from '@/lib/format';
import type { DataType } from '@/lib/metrics/types';
import type { ScenarioFlow } from '@/lib/jobs/scenarioFlow';
import { ScenarioJournalModal, ScenarioResultsBlock } from './ScenarioJournal';
import { useMemo } from 'react';

export interface ScenarioListItem {
  id: string; name: string; enabled: boolean; flow: ScenarioFlow; checkHour: number; weekdaysOnly: boolean;
  metricName: string; metricDataType: DataType; nodeCount: number;
  lastRunAt: string | null; lastRunSummary: RunSummary | { date: string; error: string } | null;
  stats: { open: number; sent30: number; lastEventAt: string | null };
}
export interface RunSummary { date: string; managers: number; noData: number; below: number; norm: number; started: number; continued: number; messages: number; closed: number; deferred: number }

const cardCls = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';

export async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
export const unitFor = (dt: DataType) => (dt === 'percent' ? 'п.п.' : dt === 'money' ? '₽' : dt === 'months' ? 'мес.' : '');
export const fmtV = (v: number | null, dt: DataType, dp = 1) => formatValue(v, dt, dt === 'int' ? 0 : dp);
export const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function ScenariosTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ scenarios: ScenarioListItem[] }>({
    queryKey: ['bot-scenarios'],
    queryFn: () => fetch('/api/settings/bots/scenarios').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const { data: fns } = useQuery<{ functions: { key: string; enabled: boolean }[] }>({
    queryKey: ['bot-functions'],
    queryFn: () => fetch('/api/settings/bots/channels').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const fnEnabled = fns?.functions.find(f => f.key === 'scenarios')?.enabled ?? null;
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['bot-scenarios'] });
  const [journalOf, setJournalOf] = useState<ScenarioListItem | null>(null);
  const dataTypes = useMemo(() => new Map((data?.scenarios ?? []).map(s => [s.id, s.metricDataType])), [data]);

  const toggle = useMutation({
    mutationFn: (s: ScenarioListItem) => fetch('/api/settings/bots/scenarios', {
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
      <section className={cardCls}>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-base font-bold text-[var(--color-text)] inline-flex items-center gap-2"><Sparkles size={16} /> Сценарии авто-коучинга</h2>
            <span className="text-xs text-[var(--color-text-muted)]">{data ? `${data.scenarios.length} шт. · включено ${data.scenarios.filter(s => s.enabled).length}` : ''}</span>
          </div>
          <Link href="/settings/bots/analitik/scenarios/new" className={btnPrimaryCls}><Plus size={14} /> Новый сценарий</Link>
        </div>
        <p className="mb-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
          Сценарий — это триггер по показателю (цель, допустимая просадка) и дерево блоков: сообщение → ждать → проверка с
          ветвлением → … Бот раз в день считает показатель на каждого менеджера и ведёт его по цепочке. Не больше одного
          сообщения сценариев менеджеру в день; неактивные аккаунты и отказавшиеся от бота не трогаем.
          {fnEnabled === false && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-md bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] px-2 py-0.5 text-[var(--color-warning)]">
              <BellOff size={11} /> функция «Сценарии коучинга» выключена — ничего не уйдёт, пока не включишь во «Функциях»
            </span>
          )}
        </p>

        {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
        {data && data.scenarios.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
            Сценариев пока нет. Нажми «Новый сценарий» — откроется конструктор с готовым примером «Конверсия в продажу, цель 15%».
          </div>
        )}
        <div className="flex flex-col gap-2">
          {data?.scenarios.map(s => (
            <ScenarioCard key={s.id} s={s} onToggle={() => toggle.mutate(s)} onJournal={() => setJournalOf(s)}
              onDelete={() => { if (confirm(`Удалить сценарий «${s.name}»? История цепочек и сообщений тоже удалится.`)) remove.mutate(s.id); }} />
          ))}
        </div>
        {(toggle.isError || remove.isError) && <div className="mt-2 text-xs text-[var(--color-negative)]">{((toggle.error ?? remove.error) as Error)?.message}</div>}
      </section>
      <ScenarioResultsBlock dataTypes={dataTypes} />
      {journalOf && <ScenarioJournalModal id={journalOf.id} name={journalOf.name} dataType={journalOf.metricDataType} onClose={() => setJournalOf(null)} />}
    </div>
  );
}

function ScenarioCard({ s, onToggle, onJournal, onDelete }: { s: ScenarioListItem; onToggle: () => void; onJournal: () => void; onDelete: () => void }) {
  const dt = s.metricDataType;
  const t = s.flow.trigger;
  const base = t.baseline === 'target' ? `цель ${fmtV(t.targetValue, dt)}` : `своё среднее за ${t.baselineDays} дн.`;
  const sum = s.lastRunSummary;
  const isErr = !!sum && 'error' in sum;
  return (
    <div className={`rounded-xl border p-3 ${s.enabled ? 'border-[var(--color-border)]' : 'border-dashed border-[var(--color-border)] opacity-80'}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={s.enabled} onChange={onToggle} title={s.enabled ? 'Выключить (открытые цепочки закроются)' : 'Включить'}
          className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-[var(--color-accent)]" />
        <Link href={`/settings/bots/analitik/scenarios/${s.id}`} className="min-w-0 flex-1 group">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-bold text-[var(--color-text)] group-hover:text-[var(--color-accent)]">{s.name}</span>
            {!s.enabled && <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><BellOff size={11} /> выключен</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
            <Chip><Target size={11} /> {s.metricName} · {t.windowDays} дн.</Chip>
            <Chip>{base}</Chip>
            <Chip><TrendingDown size={11} /> просадка &gt; {t.dropThreshold.toLocaleString('ru-RU')} {unitFor(dt)}</Chip>
            <Chip><GitBranch size={11} /> блоков {s.nodeCount}</Chip>
            <Chip><Clock size={11} /> {String(s.checkHour).padStart(2, '0')}:00 МСК{s.weekdaysOnly ? ', будни' : ', ежедневно'}</Chip>
          </div>
          <div className="mt-1.5 text-[10.5px] text-[var(--color-text-muted)]">
            открытых цепочек <b className="text-[var(--color-text)]">{s.stats.open}</b> · за 30 дней сообщений <b className="text-[var(--color-text)]">{s.stats.sent30}</b>
            {s.lastRunAt && sum && !isErr && (
              <> · прогон {fmtDate(s.lastRunAt)} — менеджеров {(sum as RunSummary).managers}, ниже порога {(sum as RunSummary).below}, сообщений {(sum as RunSummary).messages}, закрыто {(sum as RunSummary).closed}</>
            )}
            {isErr && <span className="text-[var(--color-negative)]"> · ошибка прогона: {(sum as { error: string }).error}</span>}
          </div>
        </Link>
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={onJournal} title="Журнал цепочек и сообщений" className="h-10 w-10 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><History size={16} /></button>
          <button onClick={onDelete} title="Удалить" className="h-10 w-10 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-negative)]"><Trash2 size={16} /></button>
          <Link href={`/settings/bots/analitik/scenarios/${s.id}`} title="Открыть конструктор" className="h-10 w-10 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><ChevronRight size={18} /></Link>
        </div>
      </div>
    </div>
  );
}
export function Chip({ children, tone }: { children: React.ReactNode; tone?: 'neg' | 'pos' | 'warn' }) {
  const cls = tone === 'neg' ? 'bg-[color-mix(in_srgb,var(--color-negative)_14%,transparent)] text-[var(--color-negative)]'
    : tone === 'pos' ? 'bg-[color-mix(in_srgb,var(--color-positive)_16%,transparent)] text-[var(--color-positive)]'
    : tone === 'warn' ? 'bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] text-[var(--color-warning)]'
    : 'bg-[var(--color-bg-hover)] text-[var(--color-text)]';
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 ${cls}`}>{children}</span>;
}
