'use client';
// Дриллдаун группы «Звонки» сводки логистов (задача #8314): та же выезжающая справа
// панель, что DrilldownDrawer «Продаж» и дрилл «Ответов» (общая оболочка SidePanelShell).
// Список = население числа в ячейке (metricId → условие на сервере, callDrillWhere),
// свой период, итог, сортировка по заголовкам; период и сортировка — в URL.
// Номер — только последние 4 цифры (ПДн), записи разговоров и тексты не показываем.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Info, Loader2, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import type { DateRange } from '@/lib/period';
import { recomputeComparison } from '@/lib/period';
import { useUrlState, dateRangeParam, useUrlStateBatch } from '@/lib/hooks/useUrlState';
import { useUrlSort, sortRows } from '@/lib/hooks/useUrlSort';
import { SidePanelShell } from '@/features/reports/ui/SidePanelShell';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { SortableTh } from '@/components/ui/SortableTh';
import { CALLS_DATA_FROM } from '@/lib/realizations/callMetrics';
import { DASH, fmt1, fmtDateTime, fmtInt } from './format';
import type { CallDrillItem } from '@/app/api/realizations/calls/route';

const TRANSCRIPTION: Record<string, string> = {
  transcribed: 'готова', queued: 'в очереди', transcribing: 'идёт', no_recording: 'нет записи', skipped: 'не нужна', failed: 'ошибка',
};
const td = 'border-b border-[var(--color-table-row-border,var(--color-border))] px-2 h-[34px] whitespace-nowrap';
const callsWord = (n: number) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? 'звонок' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'звонка' : 'звонков';
};
const mmss = (s: number | null) => (s === null ? DASH : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

type Col = 'time' | 'dir' | 'phone' | 'dur' | 'status' | 'tr' | 'logist';
const COLS: readonly Col[] = ['time', 'dir', 'phone', 'dur', 'status', 'tr', 'logist'];
const getVal = (r: CallDrillItem, k: Col): number | string | null => {
  switch (k) {
    case 'time': return r.startedAt;
    case 'dir': return r.direction;
    case 'phone': return r.phone;
    case 'dur': return r.durationSec;
    case 'status': return r.answered ? 1 : 0;
    case 'tr': return r.transcription;
    case 'logist': return r.logist;
  }
};

/** Параметры состояния дрилла в URL (кроме drill/drillMetric — их пишет отчёт). */
export const CALLS_DRILL_URL_KEYS = ['drillPeriod', 'drillSort'] as const;

export function LogistCallsDrill({ scope, name, metricId, metricName, period, onClose }: {
  /** logist=<id,…> | region=<код> | '' (все логисты) — готовая query-строка для API. */
  scope: string; name: string; metricId?: string | null; metricName?: string; period: DateRange; onClose: () => void;
}) {
  const defaultPeriod = useMemo(() => period, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [localPeriod, setLocalPeriod] = useUrlState<DateRange>('drillPeriod', dateRangeParam(defaultPeriod));
  const comparison = useMemo(() => recomputeComparison(localPeriod), [localPeriod]);
  const { sort, toggle } = useUrlSort<Col>('drillSort', COLS);
  const patch = useUrlStateBatch('push');

  const qs = new URLSearchParams(scope);
  qs.set('from', localPeriod.from.toISOString());
  qs.set('to', localPeriod.to.toISOString());
  if (metricId) qs.set('metricId', metricId);
  const q = useQuery<{ items: CallDrillItem[]; truncated: boolean; hasAccount: boolean; sharedWith: string | null; note: string | null; shared: string[] }>({
    queryKey: ['realizations', 'calls', qs.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/realizations/calls?${qs}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 403 ? 'Недостаточно прав: раздел «Реализация» доступен только роли «Администратор»' : body?.error || `Ошибка ${res.status}`);
      return body;
    },
  });
  const rows = q.data?.items ?? [];
  const sorted = useMemo(() => sortRows(rows, sort.key ? sort : { key: 'time', dir: 'desc' }, getVal), [rows, sort]);
  const multi = new Set(rows.map(r => r.logist)).size > 1;
  const nOut = rows.filter(r => r.direction === 'outbound').length;
  const lineMin = rows.reduce((s, r) => s + (r.answered ? r.durationSec ?? 0 : 0), 0) / 60; // как в сводке: только состоявшиеся
  const early = format(localPeriod.from, 'yyyy-MM-dd') < CALLS_DATA_FROM;
  const changed = localPeriod.from.getTime() !== defaultPeriod.from.getTime() || localPeriod.to.getTime() !== defaultPeriod.to.getTime();

  function close() {
    patch(Object.fromEntries(CALLS_DRILL_URL_KEYS.map(k => [k, null])));
    onClose();
  }
  const th = (k: Col, label: string, align: 'left' | 'right' = 'left', sticky = false) => (
    <SortableTh key={k} label={label} active={sort.key === k} dir={sort.dir} onClick={() => toggle(k)} align={align} sticky={sticky} />
  );

  return (
    <SidePanelShell
      ariaLabel={`Звонки: ${name}`}
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
          Звонки логистов собираются с 30.09.2026 — за более ранние дни данных нет.
        </div>
      )}
      {q.isLoading && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Загружаем звонки…</div>}
      {q.error && <div className="m-3 sm:mx-6 rounded-lg border border-[var(--color-negative)]/40 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]">{(q.error as Error).message}</div>}
      {q.data && (rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">
          {q.data.hasAccount ? 'За период в этой колонке звонков нет.'
            : q.data.sharedWith ? `Учётная запись Битрикса общая — её звонки показаны у логиста ${q.data.sharedWith}.`
            : 'У логиста нет учётной записи Битрикса — звонки не к кому привязать.'}
          {changed ? (
            <button type="button" onClick={() => setLocalPeriod(defaultPeriod)} className="focus-ring ml-2 font-medium text-[var(--brand)] hover:underline">Вернуть период отчёта</button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 sm:px-6 py-2 text-[13px] text-[var(--color-text)]">
            <span className="font-semibold">Итого: {fmtInt(rows.length)} {callsWord(rows.length)}{q.data.truncated ? ' (показаны последние 2 000)' : ''}</span>
            <span className="text-[var(--color-text-muted)]">исходящих {fmtInt(nOut)} · входящих {fmtInt(rows.length - nOut)} · на линии {fmt1(lineMin)} мин</span>
            {q.data.note && <span className="text-xs text-[var(--color-text-muted)]">· {q.data.note}</span>}
            {q.data.shared.length > 0 && (
              <span className="text-xs text-[var(--color-text-muted)]">· учётка Битрикса общая с: {q.data.shared.join(', ')}</span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-auto border-t border-[var(--color-border)]">
            <table className="w-full border-collapse text-[13px] text-[var(--color-text)]">
              <thead><tr>
                {th('time', 'Время', 'left', true)}{th('dir', 'Вх. / исх.')}{th('phone', 'Номер')}{th('dur', 'Длительность', 'right')}
                {th('status', 'Статус')}{th('tr', 'Расшифровка')}{multi ? th('logist', 'Логист') : null}
              </tr></thead>
              <tbody>{sorted.map(c => (
                <tr key={c.id} className="report-row">
                  <td className={`${td} sticky left-0 z-10 bg-[var(--color-bg)] tabular-nums`}>{fmtDateTime(c.startedAt)}</td>
                  <td className={td}>
                    <span className="inline-flex items-center gap-1.5" title={c.direction === 'outbound' ? 'Исходящий' : 'Входящий'}>
                      {c.direction === 'outbound'
                        ? <PhoneOutgoing size={14} className="text-[var(--color-text-muted)]" aria-hidden />
                        : <PhoneIncoming size={14} className="text-[var(--color-text-muted)]" aria-hidden />}
                      {/* На телефоне — только значок: освобождает место под длительность и статус. */}
                      <span className="sr-only sm:not-sr-only">{c.direction === 'outbound' ? 'Исходящий' : 'Входящий'}</span>
                    </span>
                  </td>
                  <td className={`${td} tabular-nums text-[var(--color-text-muted)]`} title="Номер скрыт, видны последние 4 цифры">{c.phone ?? DASH}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    {mmss(c.durationSec)}
                    {c.short ? <span className="ml-1.5 text-xs font-medium text-[var(--warning-text)]">короткий</span> : null}
                  </td>
                  <td className={td}>
                    {c.answered
                      ? <span className="text-[var(--success-text)]">Состоялся</span>
                      : <span className="text-[var(--danger-text)]">{c.direction === 'inbound' ? 'Пропущен' : 'Не дозвонились'}</span>}
                    {c.failedReason ? <span className="ml-1.5 text-xs text-[var(--color-text-muted)]">{c.failedReason}</span> : null}
                  </td>
                  <td className={`${td} text-[var(--color-text-muted)]`}>{c.transcription ? TRANSCRIPTION[c.transcription] ?? c.transcription : DASH}</td>
                  {multi ? <td className={`${td} max-w-[200px] truncate`} title={c.logist ?? ''}>{c.logist ?? DASH}</td> : null}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ))}
    </SidePanelShell>
  );
}
