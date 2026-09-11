'use client';
// График динамики одной ячейки «Матрицы переходов» (правка владельца 11.09:
// «кнопка графика на каждом квадратике, как в основных отчётах; шаг временной
// шкалы по умолчанию — неделя»).
//
// Почему не переиспользован MetricChartModal: тот построен на МЕТРИКЕ каталога
// (Metric + /api/reports/metric-series, определения из sqlGen). Ячейка матрицы —
// не метрика, а пара категорий, поэтому ряд считает свой движок
// (fetchTransitionSeries), а здесь — тонкая обёртка над Recharts с теми же
// повадками: модал поверх панели, переключатель шага, сверка с ячейкой.
//
// На графике две линии по одной шкале процентов (правило «одна ось»):
//   * доля B среди повторных покупок после A — это и есть цифра ячейки;
//   * конверсия A в повторную покупку вообще (denom/ship) — контекст: доля могла
//     вырасти просто потому, что возвращаться стали чаще.
// Абсолюты (отгрузок / повторов / связок) — в подсказке точки, чтобы не смешивать
// проценты и штуки на одной оси.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { ru } from 'date-fns/locale';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { useEscapeClose } from '@/lib/hooks/useEscapeClose';
import type { TransitionSeriesResult, TransitionSeriesStep } from '@/features/reports/engine/productMatrix';

const STEP_LABELS: Record<TransitionSeriesStep, string> = { day: 'День', week: 'Неделя', month: 'Месяц' };

function bucketLabel(b: string, step: TransitionSeriesStep): string {
  const d = parseISO(b);
  if (step === 'month') return format(d, 'LLL yy', { locale: ru });
  return format(d, 'd MMM', { locale: ru });
}

interface Row {
  label: string; bucket: string;
  share: number | null; conv: number | null;
  ship: number; denom: number; n: number;
}

function PointTooltip({ active, payload, step }: {
  active?: boolean; payload?: { payload?: Row }[]; step: TransitionSeriesStep;
}) {
  const r = payload?.[0]?.payload;
  if (!active || !r) return null;
  const sub = step === 'week' ? 'неделя с ' : step === 'month' ? '' : '';
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-[var(--color-text)]">{sub}{bucketLabel(r.bucket, step)}</div>
      <div className="mt-1 text-[var(--color-text)] tabular-nums">
        отгрузок категории: <b>{r.ship}</b>
      </div>
      <div className="text-[var(--color-text)] tabular-nums">
        из них с продолжением: <b>{r.denom}</b>
        {r.conv !== null && <span className="text-[var(--color-text-muted)]"> ({r.conv.toFixed(0)} %)</span>}
      </div>
      <div className="text-[var(--color-text)] tabular-nums">
        в том числе нужная связка: <b>{r.n}</b>
        {r.share !== null && <span className="text-[var(--color-text-muted)]"> ({r.share.toFixed(r.share >= 10 ? 0 : 1)} %)</span>}
      </div>
    </div>
  );
}

export function TransitionSeriesModal({ from, to, filters, cellPct, onClose }: {
  from: string;
  to: string;
  /** Тело запроса матрицы (период, отделы, менеджеры, пилюли, mode, anchor). */
  filters: Record<string, unknown>;
  /** Значение ячейки — для сверки «график про ту же цифру». */
  cellPct: number | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<TransitionSeriesStep>('week'); // дефолт по ТЗ
  useEscapeClose(onClose);

  const body = useMemo(() => ({ ...filters, from, to, step }), [filters, from, to, step]);
  const { data, isLoading, error } = useQuery<TransitionSeriesResult>({
    queryKey: ['matrix-transitions-series', body],
    queryFn: async () => {
      const res = await fetch('/api/reports/product-matrix/transitions/series', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const rows: Row[] = useMemo(() => (data?.points ?? []).map(p => ({
    bucket: p.bucket,
    label: bucketLabel(p.bucket, data?.step ?? step),
    // Доля считается только там, где были повторы: иначе пустая неделя рисовала бы
    // ноль и «обрушивала» линию, которой в этой точке просто нет.
    share: p.denom > 0 ? (p.n / p.denom) * 100 : null,
    conv: p.ship > 0 ? (p.denom / p.ship) * 100 : null,
    ship: p.ship, denom: p.denom, n: p.n,
  })), [data, step]);

  const totals = useMemo(() => (data?.points ?? []).reduce(
    (a, p) => ({ ship: a.ship + p.ship, denom: a.denom + p.denom, n: a.n + p.n }),
    { ship: 0, denom: 0, n: 0 },
  ), [data]);
  const totalShare = totals.denom > 0 ? (totals.n / totals.denom) * 100 : null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-6" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-4xl max-h-[92dvh] sm:max-h-[86vh] overflow-y-auto rounded-t-xl sm:rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] shadow-2xl flex flex-col"
      >
        <div className="shrink-0 flex items-start gap-3 px-4 py-3 border-b border-[var(--color-border)]">
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-[var(--color-text)]">
              <span className="truncate">{from}</span>
              <ArrowRight size={13} className="shrink-0 text-[var(--color-accent)]" />
              <span className="truncate">{to}</span>
            </h3>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              Динамика доли внутри периода отчёта
              {totalShare !== null && (
                <> · за период <b className="text-[var(--color-text)]">{totalShare.toFixed(totalShare >= 10 ? 0 : 1)} %</b>
                  {' '}({totals.n} из {totals.denom} повторных покупок)</>
              )}
              {cellPct !== null && ' — как в ячейке'}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <div role="group" aria-label="Шаг шкалы" className="inline-flex rounded-lg border border-[var(--color-border)] overflow-hidden">
              {(['day', 'week', 'month'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStep(s)}
                  aria-pressed={step === s}
                  className={`min-h-11 sm:min-h-0 sm:py-1.5 px-2.5 text-xs transition-colors ${
                    step === s
                      ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)] font-medium'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {STEP_LABELS[s]}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              aria-label="Закрыть"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="p-3 sm:p-4">
          {error ? (
            <div className="py-10 text-center text-sm text-[var(--color-negative,#d33)]">
              {error instanceof Error ? error.message : String(error)}
            </div>
          ) : isLoading ? (
            <div className="h-[320px] bg-[var(--color-border)] rounded animate-pulse" />
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">
              Нет отгрузок «{from}» в этом периоде и срезе
            </div>
          ) : (
            <div className="scroll-x">
              <div className="min-w-[560px] h-[340px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--color-text-muted)', fontSize: 12 }}
                      tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} minTickGap={12} />
                    <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 12 }} tickLine={false}
                      axisLine={false} width={40} unit="%" />
                    <Tooltip content={<PointTooltip step={data?.step ?? step} />} />
                    <Legend wrapperStyle={{ color: 'var(--color-text-muted)', fontSize: 12 }} />
                    <Line
                      name={`Доля «${to}» в повторных покупках`}
                      type="monotone" dataKey="share" stroke="var(--color-accent)" strokeWidth={2}
                      dot={{ r: 3 }} connectNulls
                    />
                    <Line
                      name="Конверсия категории в повтор"
                      type="monotone" dataKey="conv" stroke="var(--color-text-muted)" strokeWidth={1.5}
                      strokeDasharray="4 3" dot={false} connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          <p className="mt-2 text-[11px] text-[var(--color-text-muted)] max-w-[78ch]">
            Точка — бакет по дате ИСХОДНОЙ отгрузки (та же привязка, что у ячейки). Сплошная линия —
            доля связки среди повторных покупок после «{from}»; пунктир — какая часть отгрузок
            «{from}» вообще получила продолжение: доля связки может вырасти просто потому, что
            возвращаться стали чаще. Абсолютные числа — в подсказке точки.
          </p>
        </div>
      </div>
    </div>
  );
}
