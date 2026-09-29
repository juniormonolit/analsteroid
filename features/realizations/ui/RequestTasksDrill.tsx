'use client';
// Дриллдаун «Ответов на запросы» (задача #8034 → переделка #8126 по аудиту Полины,
// находки 1, 2, 4, 5): та же выезжающая справа панель, что DrilldownDrawer «Продаж»
// (общая оболочка SidePanelShell), список = население числа в ячейке (metricId →
// условие на сервере, lib/realizations/responseDrill.ts), свой период, итог,
// сортировка по заголовкам; сортировка, период и открытая сделка — в URL.
// Номер сделки открывает DealCard (карточка сделки Монолитики). Только просмотр:
// ссылок в Битрикс нет (правило брифа #8034).

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Info, Loader2 } from 'lucide-react';
import type { DateRange } from '@/lib/period';
import { recomputeComparison } from '@/lib/period';
import { useUrlState, dateRangeParam, useUrlStateBatch } from '@/lib/hooks/useUrlState';
import { useUrlSort, sortRows } from '@/lib/hooks/useUrlSort';
import { SidePanelShell } from '@/features/reports/ui/SidePanelShell';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { DealCard } from '@/features/reports/ui/DealCard';
import { SortableTh } from '@/components/ui/SortableTh';
import { responseDrillRule } from '@/lib/realizations/responseDrill';
import { RESPONSE_RELIABLE_FROM } from '@/lib/realizations/responseMetrics';
import { median } from '@/lib/realizations/metrics';
import { DASH, fmt1, fmtDateTime, fmtInt, fmtRub } from './format';
import type { RequestTaskItem } from '@/features/reports/engine/requestResponse';

const STATUS: Record<number, string> = { 1: 'Новая', 2: 'Ждёт выполнения', 3: 'Выполняется', 4: 'Ждёт контроля', 5: 'Завершена', 6: 'Отложена', 7: 'Отклонена' };
const td = 'border-b border-[var(--color-table-row-border,var(--color-border))] px-2 h-[34px] whitespace-nowrap';
const hoursBetween = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : null);

type Col = 'task' | 'flow' | 'status' | 'created' | 'toWork' | 'firstAnswer' | 'cycle' | 'responsible' | 'deal' | 'sold';
const COLS: readonly Col[] = ['task', 'flow', 'status', 'created', 'toWork', 'firstAnswer', 'cycle', 'responsible', 'deal', 'sold'];
interface Row extends RequestTaskItem { toWorkH: number | null; firstH: number | null; cycleH: number | null }
const getVal = (r: Row, k: Col): number | string | null => {
  switch (k) {
    case 'task': return r.title ?? '';
    case 'flow': return r.flow;
    case 'status': return r.status;
    case 'created': return r.createdAt;
    case 'toWork': return r.toWorkH;
    case 'firstAnswer': return r.firstH;
    case 'cycle': return r.cycleH;
    case 'responsible': return r.responsible;
    case 'deal': return r.dealId;
    case 'sold': return r.dealAmount;
  }
};

/** Параметры состояния дрилла в URL (кроме drill/drillMetric — их пишет отчёт). */
export const TASKS_DRILL_URL_KEYS = ['drillPeriod', 'drillSort', 'drillDeal'] as const;

export function RequestTasksDrill({ managerId, name, metricId, metricName, period, onClose }: {
  managerId: string; name: string; metricId?: string | null; metricName?: string; period: DateRange; onClose: () => void;
}) {
  const defaultPeriod = useMemo(() => period, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [localPeriod, setLocalPeriod] = useUrlState<DateRange>('drillPeriod', dateRangeParam(defaultPeriod));
  const comparison = useMemo(() => recomputeComparison(localPeriod), [localPeriod]);
  const [openDeal, setOpenDeal] = useUrlState<number | null>('drillDeal', {
    parse: raw => (/^\d+$/.test(raw) ? Number(raw) : null), serialize: v => (v === null ? null : String(v)), default: null, mode: 'push',
  });
  const { sort, toggle } = useUrlSort<Col>('drillSort', COLS);
  const patch = useUrlStateBatch('push');
  const rule = responseDrillRule(metricId);

  const qs = new URLSearchParams({ managerId, from: localPeriod.from.toISOString(), to: localPeriod.to.toISOString(), ...(metricId ? { metricId } : {}) });
  const q = useQuery<{ items: RequestTaskItem[]; truncated: boolean }>({
    queryKey: ['realizations', 'tasks', qs.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/realizations/tasks?${qs}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 403 ? 'Недостаточно прав: раздел «Реализация» доступен только роли «Администратор»' : body?.error || `Ошибка ${res.status}`);
      return body;
    },
  });
  const rows: Row[] = useMemo(() => (q.data?.items ?? []).map(t => ({
    ...t, toWorkH: hoursBetween(t.createdAt, t.dateStart), firstH: hoursBetween(t.createdAt, t.firstAnswerAt), cycleH: hoursBetween(t.createdAt, t.closedAt),
  })), [q.data]);
  const sorted = useMemo(() => sortRows(rows, sort, getVal), [rows, sort]);
  const firstMed = median(rows.map(r => r.firstH).filter((v): v is number => v !== null));
  const soldSum = rows.reduce((s, r) => s + (r.dealSoldAt && r.dealAmount ? r.dealAmount : 0), 0);
  const unitWord = rule.unit === 'deals' ? 'сделок' : 'запросов';
  const early = format(localPeriod.from, 'yyyy-MM-dd') < RESPONSE_RELIABLE_FROM;

  function close() {
    // Закрытие убирает всё состояние дрилла из адреса одним шагом истории.
    patch(Object.fromEntries(TASKS_DRILL_URL_KEYS.map(k => [k, null])));
    onClose();
  }
  const th = (k: Col, label: string, align: 'left' | 'right' = 'left', sticky = false) => (
    <SortableTh key={k} label={label} active={sort.key === k} dir={sort.dir} onClick={() => toggle(k)} align={align} sticky={sticky} />
  );

  return (
    <SidePanelShell
      ariaLabel={`Запросы: ${name}`}
      title={name}
      badge={metricName}
      subtitle={<>{format(localPeriod.from, 'd MMM', { locale: ru })} — {format(localPeriod.to, 'd MMM yyyy', { locale: ru })} · время — МСК</>}
      toolbar={<PeriodRangeControls period={localPeriod} comparison={comparison} showComparison={false}
        onPeriodChange={p => setLocalPeriod(p)} onComparisonChange={() => {}} />}
      onClose={close}
    >
      {early && (
        <div role="status" className="mx-3 sm:mx-6 mt-3 flex items-start gap-2 rounded-lg border border-[var(--warning-text)]/30 bg-[var(--warning-bg)] px-3 py-2 text-[13px] text-[var(--color-text)]">
          <Info size={16} className="mt-px shrink-0 text-[var(--warning-text)]" aria-hidden />
          Первый ответ считается надёжно с 07.09.2026 — до этой даты у части запросов ответа в Битриксе нет.
        </div>
      )}
      {q.isLoading && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Загружаем запросы…</div>}
      {q.error && <div className="m-3 sm:mx-6 rounded-lg border border-[var(--color-negative)]/40 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]">{(q.error as Error).message}</div>}
      {q.data && (rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">
          За период в этой колонке {unitWord} нет.
          {localPeriod.from.getTime() !== defaultPeriod.from.getTime() || localPeriod.to.getTime() !== defaultPeriod.to.getTime() ? (
            <button type="button" onClick={() => setLocalPeriod(defaultPeriod)} className="focus-ring ml-2 font-medium text-[var(--brand)] hover:underline">Вернуть период отчёта</button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 sm:px-6 py-2 text-[13px] text-[var(--color-text)]">
            <span className="font-semibold">Итого: {fmtInt(rows.length)} {unitWord}{q.data.truncated ? ' (показаны последние 2 000)' : ''}</span>
            <span className="text-[var(--color-text-muted)]">медиана первого ответа {firstMed === null ? DASH : `${fmt1(firstMed)} ч`}</span>
            {soldSum > 0 && <span className="text-[var(--color-text-muted)]">продано на {fmtRub(soldSum)}</span>}
            {rule.note && <span className="text-xs text-[var(--color-text-muted)]">· {rule.note}</span>}
          </div>
          <div className="flex-1 min-h-0 overflow-auto border-t border-[var(--color-border)]">
            <table className="w-full border-collapse text-[13px] text-[var(--color-text)]">
              <thead><tr>
                {th('task', 'Запрос', 'left', true)}{th('flow', 'Поток')}{th('status', 'Статус')}{th('created', 'Создан')}
                {th('toWork', 'До работы, ч', 'right')}{th('firstAnswer', '1-й ответ, ч', 'right')}{th('cycle', 'Цикл, ч', 'right')}
                {th('responsible', 'Исполнитель')}{th('deal', 'Сделка')}{th('sold', 'Продажа / отгрузка', 'right')}
              </tr></thead>
              <tbody>{sorted.map(t => (
                <tr key={`${t.taskId}-${t.dealId ?? ''}`} className="report-row">
                  <td className={`${td} sticky left-0 z-10 bg-[var(--color-bg)] max-w-[160px] sm:max-w-[280px] truncate`} title={t.title ?? ''}>
                    <span className="text-[var(--color-text-muted)]">#{t.taskId}</span> {t.title ?? DASH}
                  </td>
                  <td className={td}>{t.flow ?? DASH}</td>
                  <td className={td}>
                    {t.status !== null ? STATUS[t.status] ?? t.status : DASH}
                    {t.closedAt && !t.dateStart ? <span className="ml-1.5 text-xs font-medium text-[var(--warning-text)]">без взятия в работу</span> : null}
                  </td>
                  <td className={`${td} tabular-nums`}>{fmtDateTime(t.createdAt)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmt1(t.toWorkH)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmt1(t.firstH)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmt1(t.cycleH)}</td>
                  <td className={`${td} max-w-[180px] truncate`} title={t.responsible ?? ''}>{t.responsible ?? DASH}</td>
                  <td className={td}>
                    {t.dealId ? (
                      <button type="button" onClick={() => setOpenDeal(t.dealId)} title="Открыть карточку сделки"
                        className="focus-ring rounded-sm font-medium text-[var(--brand)] hover:underline tabular-nums">{t.dealId}</button>
                    ) : DASH}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {t.dealSoldAt ? <span className="text-[var(--success-text)]">продано {fmtDateTime(t.dealSoldAt).slice(0, 8)}</span> : DASH}
                    {t.dealDeliveredAt ? <span className="ml-1 text-[var(--color-text-muted)]">· отгружено {fmtDateTime(t.dealDeliveredAt).slice(0, 8)}</span> : null}
                    {t.dealAmount ? <span className="ml-1 text-[var(--color-text-muted)]">· {fmtRub(t.dealAmount)}</span> : null}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ))}
      {openDeal !== null && <DealCard dealId={openDeal} onClose={() => setOpenDeal(null)} />}
    </SidePanelShell>
  );
}
