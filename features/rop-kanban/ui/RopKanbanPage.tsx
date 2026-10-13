'use client';
// Канбан РОПа (пилот, задача #9625, v2 — один в один с Битриксом): вкладки циклов, колонка = полоса,
// внутри столбики по менеджерам. Данные: /api/rop-kanban (схема sa). Карточка ведёт в Битрикс ссылкой;
// ничего не перетаскивается. Единственная запись раздела — галочки «менеджер × цикл» (system, /api/rop-kanban/cycles).
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, Settings2, Check } from 'lucide-react';
import { enumParam, stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Modal } from '@/components/ui/Modal';
import {
  COLUMNS, CYCLES, CYCLE_ALL, CYCLE_PARAMS, CARDS_PER_MANAGER, columnsForCycle, currentCycleByTime,
  type ColumnDef, type CycleKey, type CycleParam,
} from '../engine/config';
import type { KanbanBoard, KanbanColumnData, KanbanDealCard, KanbanManagerLane, KanbanTaskCard } from '../engine/kanban';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fmtMoney = (n: number) => `${rub.format(n)} ₽`;
const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
};
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const NEUTRAL = '#6b7280';

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export function RopKanbanPage() {
  const [defaultCycle] = useState<CycleParam>(() => currentCycleByTime());
  const [cycle, setCycle] = useUrlState<CycleParam>('cycle', { ...enumParam(CYCLE_PARAMS, defaultCycle), mode: 'push' });
  const [manager, setManager] = useUrlState('manager', stringParam(''));
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery<KanbanBoard, ApiError>({
    queryKey: ['rop-kanban', cycle, manager],
    queryFn: async () => {
      const qs = new URLSearchParams({ cycle });
      if (manager) qs.set('manager', manager);
      const r = await fetch(`/api/rop-kanban?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j.error ?? `Ошибка ${r.status}`);
      return j as KanbanBoard;
    },
    refetchInterval: 60_000,
    retry: false,
  });

  if (error?.status === 403) {
    return <AccessDenied reason="Канбан РОПа — закрытый пилот: доступ выдаётся лично, не по роли." />;
  }

  const visible = columnsForCycle(cycle);
  const dataByKey = new Map<string, KanbanColumnData>((data?.columns ?? []).map(c => [c.key, c]));

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex max-w-[1800px] min-w-0 flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-[var(--color-text)]">Канбан РОПа</h1>
              <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-xs text-[var(--color-accent)]">пилот · только чтение</span>
            </div>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Данные Монолитики (sa), без записи в Битрикс.
              {data ? ` Обновлено в ${fmtTime(data.generatedAt)} МСК.` : ''}
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <label className="sr-only" htmlFor="rk-manager">Менеджер</label>
            <select
              id="rk-manager" value={manager} onChange={e => setManager(e.target.value)}
              className="min-h-11 min-w-0 max-w-[50vw] rounded-lg bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] sm:max-w-xs sm:text-sm"
            >
              <option value="">Вся зона ответственности</option>
              {(data?.managers ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Настроить циклы менеджеров" title="Настроить циклы менеджеров"
              className="tap-target flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
              <Settings2 size={16} />
            </button>
            <button type="button" onClick={() => refetch()} aria-label="Обновить" title="Обновить"
              className="tap-target flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
              <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        {error && error.status !== 403 && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>
        )}
        {data?.scopeNotice && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">{data.scopeNotice}</div>
        )}

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Итоги за сегодня">
          <Kpi label="Продажи сегодня" count={data?.salesCount} sum={data?.salesSum} loading={isLoading} tone="var(--color-positive)" />
          <Kpi label="Брони сегодня" count={data?.reservedCount} sum={data?.reservedSum} loading={isLoading} tone="var(--color-accent)" />
        </section>

        <nav className="flex min-w-0 flex-wrap gap-2" role="tablist" aria-label="Циклы дня">
          {[...CYCLES.map(c => ({ key: c.key as CycleParam, label: c.short, title: c.title })), { key: CYCLE_ALL as CycleParam, label: 'Все колонки', title: 'Все 29 колонок (режим «все циклы»)' }].map(t => {
            const active = cycle === t.key;
            const n = columnsForCycle(t.key).length;
            return (
              <button
                key={t.key} type="button" role="tab" aria-selected={active} title={t.title} onClick={() => setCycle(t.key)}
                className={`min-h-11 rounded-lg px-3 text-sm ${active ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
              >
                {t.label} <span className={active ? 'opacity-80' : 'text-[var(--color-text-muted)]'}>· {n}</span>
              </button>
            );
          })}
        </nav>
        {cycle !== CYCLE_ALL && (
          <p className="-mt-2 text-xs text-[var(--color-text-muted)]">
            {CYCLES.find(c => c.key === cycle)?.title}: колонки этого цикла и колонки «всегда».
          </p>
        )}

        {isLoading ? (
          <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">Загрузка…</div>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {visible.map(def => <Stripe key={def.key} def={def} data={dataByKey.get(def.key)} />)}
          </div>
        )}
      </div>
      <CycleSettings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function Kpi({ label, count, sum, loading, tone }: { label: string; count?: number; sum?: number; loading: boolean; tone: string }) {
  return (
    <div className="rounded-xl bg-[var(--color-bg-surface)] px-4 py-3">
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
        <span className="text-2xl font-semibold tabular-nums" style={{ color: tone }}>{loading ? '—' : count ?? 0}</span>
        <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{loading ? '' : fmtMoney(sum ?? 0)}</span>
      </div>
    </div>
  );
}

/** Колонка Битрикса = горизонтальная полоса: шапка (название, сумма, счётчик) + столбики менеджеров. */
function Stripe({ def, data }: { def: ColumnDef; data?: KanbanColumnData }) {
  const lanes = data?.lanes ?? [];
  const total = data?.total ?? 0;
  return (
    <section className="min-w-0 overflow-hidden rounded-xl bg-[var(--color-bg-surface)]" aria-label={def.title}>
      <div
        className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 px-4 py-2"
        style={{ background: def.color ?? NEUTRAL, color: def.light ? '#2f2f2f' : '#fff' }}
      >
        <h2 className="min-w-0 text-sm font-semibold">
          {def.title}
          {def.kind === 'deals' && def.computed ? ` (${fmtMoney(data?.sum ?? 0)})` : ''}
        </h2>
        <span className="text-sm tabular-nums">{def.computed ? `(${total})` : '—'}</span>
      </div>
      {!def.computed ? (
        <div className="px-4 py-4 text-sm text-[var(--color-text-muted)]">
          <span className="font-medium text-[var(--color-text)]">В Монолитике ещё не считается.</span>{' '}
          Колонка есть в Битриксе, но {def.missing}.
        </div>
      ) : lanes.length === 0 ? (
        <div className="px-4 py-4 text-sm text-[var(--color-text-muted)]">Пусто</div>
      ) : (
        <div className="flex min-w-0 items-start gap-3 overflow-x-auto p-3" style={{ scrollSnapType: 'x proximity' }}>
          {lanes.map(l => <Lane key={l.id} lane={l} kind={def.kind} />)}
        </div>
      )}
    </section>
  );
}

function Lane({ lane, kind }: { lane: KanbanManagerLane; kind: 'deals' | 'tasks' }) {
  const shown = kind === 'deals' ? lane.deals.length : lane.tasks.length;
  return (
    <div className="flex w-60 shrink-0 flex-col gap-2 rounded-lg bg-[var(--color-bg)] p-2" style={{ scrollSnapAlign: 'start' }}>
      <div className="px-1">
        <div className="truncate text-sm font-medium text-[var(--color-text)]" title={lane.name}>{lane.name} ({lane.count})</div>
        {kind === 'deals' && <div className="text-xs tabular-nums text-[var(--color-text-muted)]">{fmtMoney(lane.sum)}</div>}
      </div>
      <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto">
        {kind === 'deals' ? lane.deals.map(d => <DealCard key={d.id} d={d} />) : lane.tasks.map(t => <TaskCard key={t.id} t={t} />)}
        {lane.count > shown && <div className="px-1 py-1 text-center text-xs text-[var(--color-text-muted)]">Показано {CARDS_PER_MANAGER} из {lane.count}</div>}
      </div>
    </div>
  );
}

function DealCard({ d }: { d: KanbanDealCard }) {
  return (
    <a href={d.url} target="_blank" rel="noreferrer" className="flex min-h-11 shrink-0 flex-col gap-1 rounded-lg bg-[var(--color-bg-surface)] px-3 py-2 hover:bg-[var(--color-bg-hover)]">
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-3 min-w-0 break-words text-sm font-medium leading-snug text-[var(--color-text)]" title={d.title}>{d.title}</span>
        <ExternalLink size={12} className="mt-1 shrink-0 text-[var(--color-text-muted)] opacity-60" aria-hidden />
      </div>
      <div className="text-sm font-semibold tabular-nums text-[var(--color-text)]">{fmtMoney(d.amount)}</div>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.stageColor || NEUTRAL }} aria-hidden />
        <span className="min-w-0 truncate" title={d.stageName}>{d.stageName}</span>
      </div>
      <div className="text-xs tabular-nums text-[var(--color-text-muted)]">{fmtDate(d.createdAt)}</div>
    </a>
  );
}

function TaskCard({ t }: { t: KanbanTaskCard }) {
  return (
    <div className="flex shrink-0 flex-col gap-1 rounded-lg bg-[var(--color-bg-surface)] px-3 py-2">
      <a href={t.url} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-2 hover:underline">
        <span className="line-clamp-3 min-w-0 break-words text-sm font-medium leading-snug text-[var(--color-text)]" title={t.title}>{t.title}</span>
        <ExternalLink size={12} className="mt-1 shrink-0 text-[var(--color-text-muted)] opacity-60" aria-hidden />
      </a>
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
        <span className="tabular-nums">{t.deadlineAt ? `срок ${fmtDate(t.deadlineAt)}` : 'без срока'}</span>
        {t.dealUrl && <a href={t.dealUrl} target="_blank" rel="noreferrer" className="shrink-0 hover:underline" title={t.dealTitle ?? undefined}>сделка</a>}
      </div>
    </div>
  );
}

interface CycleSettings {
  managers: { id: string; name: string }[];
  cycles: { key: CycleKey; title: string; short: string }[];
  restrictions: Record<string, CycleKey[]>;
}

/** Окно «менеджер × цикл» (аналог «Настроить циклы менеджеров» Битрикса). Пишет только system. */
function CycleSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const q = useQuery<CycleSettings, ApiError>({
    queryKey: ['rop-kanban-cycles'],
    enabled: open,
    queryFn: async () => {
      const r = await fetch('/api/rop-kanban/cycles');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j.error ?? `Ошибка ${r.status}`);
      return j as CycleSettings;
    },
    retry: false,
  });
  const managers = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.managers ?? []).filter(m => !s || m.name.toLowerCase().includes(s));
  }, [q.data, search]);

  const save = async (managerId: string, disabled: CycleKey[]) => {
    setSaveError(null);
    const prev = q.data;
    if (prev) qc.setQueryData<CycleSettings>(['rop-kanban-cycles'], { ...prev, restrictions: { ...prev.restrictions, [managerId]: disabled } });
    const r = await fetch('/api/rop-kanban/cycles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ managerId, disabledCycles: disabled }) });
    if (!r.ok) {
      if (prev) qc.setQueryData(['rop-kanban-cycles'], prev);
      const j = await r.json().catch(() => ({}));
      setSaveError(j.error ?? 'Не удалось сохранить');
    }
  };
  const toggle = (managerId: string, key: CycleKey) => {
    const cur = q.data?.restrictions[managerId] ?? [];
    void save(managerId, cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Циклы менеджеров" desktopWidth="sm:max-w-3xl">
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        Галочка — цикл включён у менеджера. Снять — цикл выключен. Без записи включены все циклы. Настройка сохраняется в Монолитике, в Битрикс ничего не пишется.
      </p>
      <label className="sr-only" htmlFor="rk-cyc-search">Поиск менеджера</label>
      <input id="rk-cyc-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск менеджера"
        className="mb-3 min-h-11 w-full rounded-lg bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] sm:text-sm" />
      {saveError && <div className="mb-2 text-sm text-[var(--color-negative)]">{saveError}</div>}
      {q.isLoading && <div className="py-6 text-center text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {q.error && <div className="py-6 text-center text-sm text-[var(--color-negative)]">{q.error.message}</div>}
      {q.data && (
        <div className="scroll-x max-h-[55dvh] overflow-y-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="sticky top-0 bg-[var(--color-bg-overlay)]">
              <tr className="text-left text-xs text-[var(--color-text-muted)]">
                <th className="px-2 py-2 font-medium">Менеджер</th>
                {q.data.cycles.map(c => <th key={c.key} className="px-2 py-2 text-center font-medium" title={c.title}>{c.short}</th>)}
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {managers.length === 0 && <tr><td colSpan={q.data.cycles.length + 2} className="px-2 py-6 text-center text-[var(--color-text-muted)]">Нет менеджеров</td></tr>}
              {managers.map(m => {
                const off = q.data!.restrictions[m.id] ?? [];
                return (
                  <tr key={m.id} className="border-t border-[var(--color-table-row-border)]">
                    <td className="px-2 py-1 text-[var(--color-text)]">{m.name}</td>
                    {q.data!.cycles.map(c => {
                      const on = !off.includes(c.key);
                      return (
                        <td key={c.key} className="px-2 py-1 text-center">
                          <button type="button" role="checkbox" aria-checked={on} aria-label={`${m.name}: ${c.short}`} onClick={() => toggle(m.id, c.key)}
                            className={`tap-target mx-auto flex h-6 w-6 items-center justify-center rounded ${on ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-surface)] text-transparent'}`}>
                            <Check size={14} />
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-2 py-1 text-right">
                      {off.length > 0 && <button type="button" onClick={() => void save(m.id, [])} className="text-xs text-[var(--color-text-muted)] hover:underline">сбросить</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// Реэкспорт для тестов/сверки: список колонок, который рисует страница.
export const ALL_COLUMNS = COLUMNS;
