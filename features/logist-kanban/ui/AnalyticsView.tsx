'use client';
// Аналитика руководителей (S5, LOGIST_REQUESTS_SPEC.md «Плитки и аналитика»): плитки за период (как на доске — TilesRow)
// и разрез регион → департамент → очередь → логист, как в Панели снабжения. GET /api/logist-kanban/analytics.
// Доступ решает сервер: РОП — менеджеры своей зоны (ropScope), руководитель логистики / админ — весь поток.
// Период и фильтры — в URL (useLogistFilters: ?from=&to=&queue=…), панель «Фильтры» — та же, что у доски (S3).
// Таблица — в .scroll-x (правило 2); на телефоне видны «Узел / Новые / Ответ», остальное — горизонтальным скроллом таблицы.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import type { AnalyticsResponse, AnalyticsRow } from '../engine/requests/contract';
import { defaultPeriod } from '../engine/requests/tiles';
import { lkFetch, type LogistApiError } from './api';
import { ActiveChips, FiltersButton, ResetAllButton } from './FiltersPanel';
import { TilesRow } from './LogistKanbanPage';
import { hours, moneyShort } from './format';
import { useLogistFilters } from './useLogistFilters';

const PRESETS = [{ days: 7, label: '7 дней' }, { days: 30, label: '30 дней' }, { days: 90, label: '90 дней' }];
const LEVEL_PAD = { region: 0, dept: 1, queue: 2, logist: 3 } as const;
const LEVEL_NAME = { region: 'регион', dept: 'департамент', queue: 'очередь', logist: 'логист' } as const;

const DATE = 'min-h-11 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 text-base text-[var(--color-text)] sm:text-sm';

export function AnalyticsView() {
  const f = useLogistFilters();
  const { filters } = f;
  const q = useQuery<AnalyticsResponse, LogistApiError>({
    queryKey: ['logist-analytics', f.queryString],
    queryFn: () => lkFetch<AnalyticsResponse>(`/api/logist-kanban/analytics${f.queryString ? `?${f.queryString}` : ''}`),
    placeholderData: prev => prev,
    refetchOnWindowFocus: false,
  });
  const d = q.data;
  const def = defaultPeriod(new Date());
  const from = filters.createdFrom ?? d?.periodFrom ?? def.from;
  const to = filters.createdTo ?? d?.periodTo ?? def.to;
  const setPreset = (days: number) => {
    const now = new Date();
    const p = { from: new Date(now.getTime() - (days - 1) * 86_400_000 + 3 * 3600_000).toISOString().slice(0, 10), to: def.to };
    f.replace({ ...filters, createdFrom: p.from, createdTo: p.to });
  };
  const activeDays = useMemo(() => {
    if (!filters.createdFrom) return 30;
    if (filters.createdTo && filters.createdTo !== def.to) return null;
    return Math.round((Date.parse(def.to) - Date.parse(filters.createdFrom)) / 86_400_000) + 1;
  }, [filters.createdFrom, filters.createdTo, def.to]);

  // раскрытие узлов: по умолчанию открыты регионы (видны департаменты)
  const [open, setOpen] = useState<Set<string> | null>(null);
  const opened = open ?? new Set((d?.rows ?? []).filter(r => r.level === 'region').map(r => r.key));
  const toggle = (key: string) => setOpen(() => { const s = new Set(opened); if (s.has(key)) s.delete(key); else s.add(key); return s; });
  const children = useMemo(() => {
    const m = new Map<string | null, AnalyticsRow[]>();
    for (const r of d?.rows ?? []) { const l = m.get(r.parentKey) ?? []; l.push(r); m.set(r.parentKey, l); }
    return m;
  }, [d]);
  const visible: AnalyticsRow[] = [];
  const walk = (parent: string | null) => {
    for (const r of children.get(parent) ?? []) { visible.push(r); if (opened.has(r.key)) walk(r.key); }
  };
  walk(null);

  const chip = (on: boolean) => `inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`;

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Аналитика запросов логистам">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {PRESETS.map(p => (
          <button key={p.days} type="button" aria-pressed={activeDays === p.days} onClick={() => setPreset(p.days)} className={chip(activeDays === p.days)}>{p.label}</button>
        ))}
        <span className="flex min-w-0 items-center gap-1">
          <input type="date" aria-label="С" value={from} max={to} onChange={e => e.target.value && f.set('createdFrom', e.target.value)} className={DATE} />
          <span className="text-[var(--color-text-muted)]">—</span>
          <input type="date" aria-label="По" value={to} min={from} onChange={e => e.target.value && f.set('createdTo', e.target.value)} className={DATE} />
        </span>
        <FiltersButton s={f} options={d?.options} />
        <ResetAllButton s={f} />
        {q.isFetching && <RefreshCw size={14} className="animate-spin text-[var(--color-text-muted)]" aria-label="обновляется" />}
      </div>
      <ActiveChips s={f} options={d?.options} />
      {d && (
        <p className="text-[12px] text-[var(--color-text-muted)]">
          {d.scope === 'all' ? 'Весь поток запросов.' : 'Запросы менеджеров вашей зоны.'} Скорости — медианы рабочих часов (9–18 МСК) по циклам периода;
          логист узла — тот, у кого запрос сейчас. «Сейчас на логисте / просрочено» — снимок на текущий момент.
        </p>
      )}

      {q.error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{q.error.message}</div>}
      {q.isLoading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Считаю…</div>}
      {d && <TilesRow tiles={d.total.tiles} />}

      {d && (
        <div className="scroll-x min-w-0 rounded-xl border border-[var(--color-border)]">
          <table className="w-full min-w-[760px] border-collapse text-[13px] text-[var(--color-text)]">
            <thead className="bg-[var(--color-bg-surface)] text-left text-[11.5px] text-[var(--color-text-muted)]">
              <tr>
                <th className="sticky left-0 z-[1] w-[170px] bg-[var(--color-bg-surface)] px-3 py-2 font-medium sm:w-auto">Регион → департамент → очередь → логист</th>
                <th className="px-2 py-2 text-right font-medium" title="Отправлено запросов за период">Новые</th>
                <th className="px-2 py-2 text-right font-medium" title="Возвратов на доработку за период">Возвраты</th>
                <th className="px-2 py-2 text-right font-medium" title="Медиана: старт цикла → «Взять»">Взятие</th>
                <th className="px-2 py-2 text-right font-medium" title="Медиана: старт цикла → первый вариант">Ответ</th>
                <th className="px-2 py-2 text-right font-medium" title="Медиана: «Взять» → ответ">Выполн.</th>
                <th className="px-2 py-2 text-right font-medium" title="Проданные сделки по запросам периода">Продажи</th>
                <th className="px-2 py-2 text-right font-medium" title="Сейчас на логисте / из них SLA просрочен">Сейчас / проср.</th>
              </tr>
            </thead>
            <tbody>
              <Row r={d.total} bold />
              {visible.map(r => (
                <Row key={r.key} r={r} expandable={(children.get(r.key)?.length ?? 0) > 0} open={opened.has(r.key)} onToggle={() => toggle(r.key)} />
              ))}
              {d.rows.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-[var(--color-text-muted)]">За период запросов нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Row({ r, bold, expandable, open, onToggle }: { r: AnalyticsRow; bold?: boolean; expandable?: boolean; open?: boolean; onToggle?: () => void }) {
  const t = r.tiles;
  const td = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap';
  return (
    <tr className={`border-t border-[var(--color-border)] ${bold ? 'font-semibold' : ''}`}>
      <td className="sticky left-0 z-[1] max-w-[170px] bg-[var(--color-bg)] px-3 py-1 sm:max-w-[280px]" style={{ paddingLeft: `${12 + LEVEL_PAD[r.level] * 14}px` }}>
        {expandable ? (
          <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-11 w-full min-w-0 items-center gap-1 text-left">
            <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
            <span className="min-w-0 truncate" title={`${LEVEL_NAME[r.level]}: ${r.label}`}>{r.label}</span>
          </button>
        ) : (
          <span className="flex min-h-11 min-w-0 items-center gap-1 pl-[18px]"><span className="min-w-0 truncate" title={bold ? undefined : `${LEVEL_NAME[r.level]}: ${r.label}`}>{bold ? 'Итого' : r.label}</span></span>
        )}
      </td>
      <td className={td}>{t.newCount}</td>
      <td className={td}>{t.reopenedCount || '—'}</td>
      <td className={td}>{hours(t.takeSpeedH)}</td>
      <td className={td}>{hours(t.answerSpeedH)}</td>
      <td className={td}>{hours(t.execSpeedH)}</td>
      <td className={td} title={t.salesCount ? `сделок: ${t.salesCount}` : undefined}>{t.salesSum ? moneyShort(t.salesSum) : '—'}</td>
      <td className={td}>{r.openNow}{r.overdueNow ? <span className="text-[var(--color-negative)]"> / {r.overdueNow}</span> : ''}</td>
    </tr>
  );
}
