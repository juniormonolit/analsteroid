'use client';
// Канбан РОПа (пилот, задача #9625) — только чтение. Данные: /api/rop-kanban (схема sa).
// Карточка ведёт в Битрикс ссылкой; ничего не перетаскивается и не пишется.
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { COLUMNS, GROUP_TITLES, CARDS_PER_COLUMN, type ColumnDef, type ColumnGroup } from '../engine/config';
import type { KanbanBoard, KanbanColumnData, KanbanDealCard, KanbanTaskCard } from '../engine/kanban';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fmtMoney = (n: number) => (Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} млн ₽` : `${rub.format(n)} ₽`);
const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
};
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

const TONE: Record<ColumnDef['tone'], string> = {
  neutral: 'var(--color-text-muted)',
  negative: 'var(--color-negative)',
  warning: 'var(--color-warning)',
  positive: 'var(--color-positive)',
  accent: 'var(--color-accent)',
};

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export function RopKanbanPage() {
  const [manager, setManager] = useUrlState('manager', stringParam(''));
  const { data, isLoading, error, refetch, isFetching } = useQuery<KanbanBoard, ApiError>({
    queryKey: ['rop-kanban', manager],
    queryFn: async () => {
      const r = await fetch(`/api/rop-kanban${manager ? `?manager=${encodeURIComponent(manager)}` : ''}`);
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

  const groups = (Object.keys(GROUP_TITLES) as ColumnGroup[])
    .map(g => ({ g, cols: COLUMNS.filter(c => c.group === g) }))
    .filter(x => x.cols.length > 0);
  const byKey = new Map<string, KanbanColumnData>((data?.columns ?? []).map(c => [c.key, c]));

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex max-w-[1800px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
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
              id="rk-manager"
              value={manager}
              onChange={e => setManager(e.target.value)}
              className="min-h-11 min-w-0 max-w-[60vw] rounded-lg bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] sm:max-w-xs sm:text-sm"
            >
              <option value="">Вся зона ответственности</option>
              {(data?.managers ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <button
              type="button"
              onClick={() => refetch()}
              className="tap-target flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
              aria-label="Обновить"
              title="Обновить"
            >
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
          <Kpi label="Продажи сегодня" count={data?.salesCount} sum={data?.salesSum} loading={isLoading} tone="positive" />
          <Kpi label="Брони сегодня" count={data?.reservedCount} sum={data?.reservedSum} loading={isLoading} tone="accent" />
        </section>

        {isLoading ? (
          <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">Загрузка…</div>
        ) : (
          <div className="-mx-4 min-w-0 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6" style={{ scrollSnapType: 'x proximity' }}>
            <div className="flex w-max items-start gap-6">
              {groups.map(({ g, cols }) => (
                <div key={g} className="flex flex-col gap-2">
                  <div className="px-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{GROUP_TITLES[g]}</div>
                  <div className="flex items-start gap-3">
                    {cols.map(def => <Column key={def.key} def={def} data={byKey.get(def.key)} />)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, count, sum, loading, tone }: { label: string; count?: number; sum?: number; loading: boolean; tone: 'positive' | 'accent' }) {
  return (
    <div className="rounded-xl bg-[var(--color-bg-surface)] px-4 py-3">
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
        <span className="text-2xl font-semibold tabular-nums" style={{ color: TONE[tone] }}>{loading ? '—' : count ?? 0}</span>
        <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{loading ? '' : fmtMoney(sum ?? 0)}</span>
      </div>
    </div>
  );
}

function Column({ def, data }: { def: ColumnDef; data?: KanbanColumnData }) {
  const total = data?.total ?? 0;
  const shown = def.kind === 'deals' ? data?.deals.length ?? 0 : data?.tasks.length ?? 0;
  return (
    <section
      className="flex w-[84vw] max-w-72 shrink-0 flex-col rounded-xl bg-[var(--color-bg-surface)] sm:w-72"
      style={{ scrollSnapAlign: 'start', borderTop: `3px solid ${TONE[def.tone]}` }}
      aria-label={def.title}
    >
      <div className="px-3 pb-2 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="min-w-0 text-sm font-semibold text-[var(--color-text)]">{def.title}</h2>
          <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{total}</span>
        </div>
        {def.kind === 'deals' && total > 0 && (
          <div className="text-xs tabular-nums text-[var(--color-text-muted)]">{fmtMoney(data?.sum ?? 0)}</div>
        )}
        <p className="mt-1 text-xs leading-snug text-[var(--color-text-muted)]">{def.hint}</p>
      </div>
      <div className="flex max-h-[60dvh] flex-col gap-2 overflow-y-auto px-2 pb-2">
        {shown === 0 && <div className="px-1 py-6 text-center text-xs text-[var(--color-text-muted)]">Пусто</div>}
        {def.kind === 'deals'
          ? data?.deals.map(d => <DealCard key={d.id} d={d} />)
          : data?.tasks.map(t => <TaskCard key={t.id} t={t} />)}
        {total > shown && (
          <div className="px-1 py-2 text-center text-xs text-[var(--color-text-muted)]">Показано {CARDS_PER_COLUMN} из {total}</div>
        )}
      </div>
    </section>
  );
}

function DealCard({ d }: { d: KanbanDealCard }) {
  return (
    <a
      href={d.url} target="_blank" rel="noreferrer"
      className="group flex min-h-11 shrink-0 flex-col gap-1 rounded-lg bg-[var(--color-bg)] px-3 py-2 hover:bg-[var(--color-bg-hover)]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-3 min-w-0 break-words text-sm font-medium leading-snug text-[var(--color-text)]" title={d.title}>{d.title}</span>
        <ExternalLink size={12} className="mt-1 shrink-0 text-[var(--color-text-muted)] opacity-60" aria-hidden />
      </div>
      <div className="text-sm font-semibold tabular-nums text-[var(--color-text)]">{fmtMoney(d.amount)}</div>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.stageColor || 'var(--color-text-muted)' }} aria-hidden />
        <span className="min-w-0 truncate" title={d.stageName}>{d.stageName}</span>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
        <span className="min-w-0 truncate">{d.managerName}</span>
        <span className="shrink-0 tabular-nums">{fmtDate(d.createdAt)}</span>
      </div>
    </a>
  );
}

function TaskCard({ t }: { t: KanbanTaskCard }) {
  return (
    <div className="flex shrink-0 flex-col gap-1 rounded-lg bg-[var(--color-bg)] px-3 py-2">
      <a href={t.url} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-2 hover:underline">
        <span className="line-clamp-3 min-w-0 break-words text-sm font-medium leading-snug text-[var(--color-text)]" title={t.title}>{t.title}</span>
        <ExternalLink size={12} className="mt-1 shrink-0 text-[var(--color-text-muted)] opacity-60" aria-hidden />
      </a>
      <div className="text-xs text-[var(--color-text-muted)]">{t.responsibleName}</div>
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
        <span className="tabular-nums">{t.deadlineAt ? `срок ${fmtDate(t.deadlineAt)}` : 'без срока'}</span>
        {t.dealUrl && (
          <a href={t.dealUrl} target="_blank" rel="noreferrer" className="shrink-0 underline-offset-2 hover:underline" title={t.dealTitle ?? undefined}>сделка</a>
        )}
      </div>
    </div>
  );
}
