'use client';
// Список задач по клику на ячейку отчёта «Ответы на запросы» (методика Панели снабжения):
// та же выезжающая справа панель (SidePanelShell), что у «Продаж», свой период,
// сортировка по заголовкам (в URL). Данные — /api/realizations/supply/tasks: по одной
// строке на событие (запрос / ответ / продажа…); для CR-метрик строка = сделка.
// Скорости — в рабочих минутах (будни 09–18 МСК), показываем «ч:мм».
// Только просмотр; ссылки на задачу и сделку ведут в Битрикс24 портала.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { DateRange } from '@/lib/period';
import { recomputeComparison } from '@/lib/period';
import { useUrlState, dateRangeParam, useUrlStateBatch } from '@/lib/hooks/useUrlState';
import { useUrlSort, sortRows } from '@/lib/hooks/useUrlSort';
import { SidePanelShell } from '@/features/reports/ui/SidePanelShell';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { SortableTh } from '@/components/ui/SortableTh';
import { DASH, fmtDateTime, fmtInt, fmtRub } from './format';
import { fmtPulled, fmtWorkMin, getSupply, type TaskListOut, type WithPulled } from './supplyShared';

const td = 'border-b border-[var(--color-table-row-border,var(--color-border))] px-2 h-[34px] whitespace-nowrap';

type Col = 'task' | 'category' | 'created' | 'stage' | 'manager' | 'supplier' | 'cycle'
  | 'take' | 'exec' | 'answer' | 'cycleMin' | 'reopens' | 'deal' | 'sold' | 'shipped' | 'outcome';
const COLS: readonly Col[] = ['task', 'category', 'created', 'stage', 'manager', 'supplier', 'cycle', 'take', 'exec', 'answer', 'cycleMin', 'reopens', 'deal', 'sold', 'shipped', 'outcome'];
const getVal = (r: TaskListOut, k: Col): number | string | null => {
  switch (k) {
    case 'task': return r.title ?? '';
    case 'category': return r.category;
    case 'created': return r.created;
    case 'stage': return r.stage;
    case 'manager': return r.manager;
    case 'supplier': return r.supplier_name;
    case 'cycle': return r.cycle;
    case 'take': return r.take_min;
    case 'exec': return r.exec_min;
    case 'answer': return r.answer_min;
    case 'cycleMin': return r.cycle_min;
    case 'reopens': return r.reopens;
    case 'deal': return r.amount ?? r.deal;
    case 'sold': return r.sold;
    case 'shipped': return r.shipped;
    case 'outcome': return r.outcome;
  }
};

/** Параметры состояния дрилла в URL (кроме drill/drillMetric — их пишет отчёт). */
export const TASKS_DRILL_URL_KEYS = ['drillPeriod', 'drillSort'] as const;

interface TasksResp { metric: string; total: number; shown: number; rows: TaskListOut[] }

export function SupplyTasksDrill({ filter, metric, name, metricName, period, onClose }: {
  /** region / dept / group / user / person / path — фильтры API панели. */
  filter: Record<string, string>;
  /** Ключ показателя панели (PICK): new, answers, gt9_pct, cr_sale_pct … */
  metric: string;
  name: string; metricName?: string; period: DateRange; onClose: () => void;
}) {
  const defaultPeriod = useMemo(() => period, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [localPeriod, setLocalPeriod] = useUrlState<DateRange>('drillPeriod', dateRangeParam(defaultPeriod));
  const comparison = useMemo(() => recomputeComparison(localPeriod), [localPeriod]);
  const { sort, toggle } = useUrlSort<Col>('drillSort', COLS);
  const patch = useUrlStateBatch('push');

  const qs = new URLSearchParams({ from: localPeriod.from.toISOString(), to: localPeriod.to.toISOString(), metric });
  for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
  const q = useQuery<WithPulled<TasksResp>>({
    queryKey: ['realizations', 'supply', 'tasks', qs.toString()],
    queryFn: () => getSupply(`/api/realizations/supply/tasks?${qs}`),
    staleTime: 60_000,
  });
  const rows = q.data?.rows ?? [];
  const sorted = useMemo(() => sortRows(rows, sort, getVal), [rows, sort]);
  const byDeal = metric.startsWith('cr_');
  const unitWord = byDeal ? 'сделок' : 'задач';
  const soldSum = useMemo(() => rows.reduce((s, r) => s + (r.outcome === 'продана' && r.amount ? r.amount : 0), 0), [rows]);

  function close() {
    // Закрытие убирает всё состояние дрилла из адреса одним шагом истории.
    patch(Object.fromEntries(TASKS_DRILL_URL_KEYS.map(k => [k, null])));
    onClose();
  }
  const th = (k: Col, label: string, align: 'left' | 'right' = 'left', sticky = false, title?: string) => (
    <SortableTh key={k} label={label} title={title} active={sort.key === k} dir={sort.dir} onClick={() => toggle(k)} align={align} sticky={sticky} />
  );
  const link = 'focus-ring rounded-sm font-medium text-[var(--brand)] hover:underline';

  return (
    <SidePanelShell
      ariaLabel={`Задачи: ${name}`}
      title={name}
      badge={metricName}
      subtitle={<>{format(localPeriod.from, 'd MMM', { locale: ru })} — {format(localPeriod.to, 'd MMM yyyy', { locale: ru })} · время — МСК{q.data?.pulledAt ? ` · ${fmtPulled(q.data.pulledAt)}` : ''}</>}
      toolbar={<PeriodRangeControls period={localPeriod} comparison={comparison} showComparison={false}
        onPeriodChange={p => setLocalPeriod(p)} onComparisonChange={() => {}} />}
      onClose={close}
    >
      {q.isLoading && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Загружаем задачи…</div>}
      {q.error && <div className="m-3 sm:mx-6 rounded-lg border border-[var(--color-negative)]/40 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]">{(q.error as Error).message}</div>}
      {q.data && (rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">
          За период в этой колонке {unitWord} нет.
          {localPeriod.from.getTime() !== defaultPeriod.from.getTime() || localPeriod.to.getTime() !== defaultPeriod.to.getTime() ? (
            <button type="button" onClick={() => setLocalPeriod(defaultPeriod)} className="focus-ring ml-2 min-h-11 sm:min-h-0 font-medium text-[var(--brand)] hover:underline">Вернуть период отчёта</button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 sm:px-6 py-2 text-[13px] text-[var(--color-text)]">
            <span className="font-semibold">{fmtInt(q.data.total)} {unitWord}{q.data.shown < q.data.total ? ` (показано ${fmtInt(q.data.shown)})` : ''}</span>
            {soldSum > 0 && <span className="text-[var(--color-text-muted)]">проданных на {fmtRub(soldSum)}</span>}
            <span className="text-xs text-[var(--color-text-muted)]">скорости — рабочие часы (ч:мм){byDeal ? ' · строка — сделка' : ''}</span>
          </div>
          <div className="scroll-x flex-1 min-h-0 overflow-auto border-t border-[var(--color-border)]">
            <table className="w-full border-collapse text-[13px] text-[var(--color-text)]">
              <thead><tr>
                {th('task', 'Задача', 'left', true)}{th('category', 'Категория')}{th('created', 'Создана')}{th('stage', 'Стадия')}
                {th('manager', 'Менеджер')}{th('supplier', 'Снабженец')}{th('cycle', 'Цикл', 'right', false, 'Номер цикла: 1 — первый ответ, 2+ — после возобновления')}
                {th('take', 'Взятие', 'right', false, 'Создание → «Выполняются», рабочие часы')}
                {th('exec', 'Выполнение', 'right', false, '«Выполняются» → «Сделаны», рабочие часы')}
                {th('answer', 'Ответ', 'right', false, 'До перехода в «Сделаны», рабочие часы')}
                {th('cycleMin', 'Цикл до приёмки', 'right', false, 'До «Завершены», рабочие часы')}
                {th('reopens', 'Возобн.', 'right')}{th('deal', 'Сделка', 'right')}
                {th('sold', 'Продана')}{th('shipped', 'Отгружена')}{th('outcome', 'Итог')}
              </tr></thead>
              <tbody>{sorted.map((t, i) => (
                <tr key={`${t.id}-${t.cycle}-${t.outcome ?? ''}-${t.deal ?? ''}-${i}`} className="report-row">
                  <td className={`${td} sticky left-0 z-10 bg-[var(--color-bg)] max-w-[160px] sm:max-w-[300px] truncate`} title={t.title ?? ''}>
                    <a href={t.task_url} target="_blank" rel="noopener noreferrer" className={`${link} tabular-nums`}>#{t.id}</a>{' '}{t.title ?? DASH}
                  </td>
                  <td className={`${td} max-w-[180px] truncate`} title={t.category ?? ''}>{t.category ?? DASH}</td>
                  <td className={`${td} tabular-nums`}>{fmtDateTime(t.created)}</td>
                  <td className={td}>{t.stage ?? DASH}{t.skip_take ? <span className="ml-1.5 text-xs font-medium text-[var(--warning-text)]">без взятия</span> : null}</td>
                  <td className={`${td} max-w-[160px] truncate`} title={t.manager ?? ''}>{t.manager ?? DASH}</td>
                  <td className={`${td} max-w-[160px] truncate`} title={t.supplier_name}>{t.supplier_name || DASH}</td>
                  <td className={`${td} text-right tabular-nums`}>{t.cycle}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmtWorkMin(t.take_min)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmtWorkMin(t.exec_min)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmtWorkMin(t.answer_min)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmtWorkMin(t.cycle_min)}</td>
                  <td className={`${td} text-right tabular-nums`}>{t.reopens || DASH}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    {t.deal && t.deal_url ? (
                      <a href={t.deal_url} target="_blank" rel="noopener noreferrer" className={`${link} inline-flex items-center gap-1`}>
                        {t.deal}<ExternalLink size={11} aria-hidden />
                      </a>
                    ) : DASH}
                    {t.amount ? <span className="ml-1 text-[var(--color-text-muted)]">· {fmtRub(t.amount)}</span> : null}
                  </td>
                  <td className={`${td} tabular-nums`}>{t.sold ? fmtDateTime(t.sold) : DASH}</td>
                  <td className={`${td} tabular-nums`}>{t.shipped ? fmtDateTime(t.shipped) : DASH}</td>
                  <td className={td}>
                    {t.outcome ? <span className={t.outcome === 'проиграна' ? 'text-[var(--danger-text)]' : 'text-[var(--success-text)]'}>{t.outcome}</span> : DASH}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ))}
    </SidePanelShell>
  );
}
