'use client';
import type { TaskerMetric } from '../../types';
import type { TaskerVerdict } from '../../types';
import type { TrainingEffectSummary, TrainingOutcome, TrainingResult } from '../types';
import { TRAINING_OUTCOME_LABELS } from '../types';
import { deltaTone, fmtDelta, fmtMetric, fmtShortDate } from './format';

// У обучения нет цели, поэтому «Рост, не дотянул» ядра здесь звучит странно — свои подписи.
const VERDICT_TEXT: Record<TaskerVerdict, string> = {
  achieved: 'рост', improved: 'рост', no_change: 'без изменений', not_enough_data: 'мало данных',
};

const OUTCOME_CLS: Record<TrainingOutcome, string> = {
  improved: 'bg-[color-mix(in_srgb,var(--color-positive)_18%,transparent)] text-[var(--color-positive)]',
  no_change: 'bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]',
  not_enough_data: 'border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)]',
};

export function OutcomeBadge({ outcome }: { outcome: TrainingOutcome }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium ${OUTCOME_CLS[outcome]}`}>{TRAINING_OUTCOME_LABELS[outcome]}</span>;
}

export function AttendanceBadge({ attended }: { attended: boolean | null }) {
  if (attended === true) return <span className="shrink-0 rounded-full bg-[var(--color-bg-hover)] px-2 py-0.5 text-[11.5px]">был</span>;
  if (attended === false) return <span className="shrink-0 rounded-full bg-[var(--color-bg-hover)] px-2 py-0.5 text-[11.5px] text-[var(--color-negative)]">не был</span>;
  return <span className="shrink-0 rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[11.5px] text-[var(--color-text-muted)]">посещение не отмечено</span>;
}

/** Подписи показателей. */
export function metricLabel(metrics: Map<string, TaskerMetric>, id: string) {
  return metrics.get(id)?.label ?? id;
}

export function MetricChips({ ids, metrics }: { ids: string[]; metrics: Map<string, TaskerMetric> }) {
  if (!ids.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {ids.map(id => <span key={id} className="max-w-full truncate rounded-full bg-[var(--color-bg-hover)] px-2 py-0.5 text-[11.5px]">{metricLabel(metrics, id)}</span>)}
    </span>
  );
}

/** Строки замера: «CR ППП: 18% → 23% (+5 п.п.) · отдел +1 п.п. · Рост». */
export function ResultLines({ results, metrics }: { results: TrainingResult[]; metrics: Map<string, TaskerMetric> }) {
  if (!results.length) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-1 text-[12.5px]">
      {results.map(r => {
        const m = metrics.get(r.metricId);
        const fmt = m?.format ?? 'number';
        const hib = m?.higherIsBetter ?? true;
        const d = r.valueBefore !== null && r.valueAfter !== null ? r.valueAfter - r.valueBefore : null;
        const dd = r.deptBefore !== null && r.deptAfter !== null ? r.deptAfter - r.deptBefore : null;
        return (
          <li key={r.metricId} className="min-w-0 break-words">
            <span className="font-medium">{metricLabel(metrics, r.metricId)}:</span>{' '}
            {r.verdict ? (
              <>
                {fmtMetric(r.valueBefore, fmt)} → {fmtMetric(r.valueAfter, fmt)}{' '}
                <span className={deltaTone(d, hib)}>({fmtDelta(d, fmt)})</span>
                <span className="text-[var(--color-text-muted)]"> · отдел <span className={deltaTone(dd, hib)}>{fmtDelta(dd, fmt)}</span></span>
                <span className="text-[var(--color-text-muted)]"> · {VERDICT_TEXT[r.verdict]}</span>
                <span className="block text-[11px] text-[var(--color-text-muted)]">
                  до {fmtShortDate(r.before.from)}–{fmtShortDate(r.before.to)}, после {fmtShortDate(r.after.from)}–{fmtShortDate(r.after.to)}
                </span>
              </>
            ) : (
              <span className="text-[var(--color-text-muted)]">замер не удался, повторим{r.error ? ` (${r.error})` : ''}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** «Прошли 10 · выросли у 8 · без изм. 1 · мало данных 1». */
export function EffectSummaryLine({ s, started }: { s: TrainingEffectSummary; started: boolean }) {
  if (!started) return null;
  const parts: React.ReactNode[] = [<b key="a">Прошли {s.attended}</b>];
  if (s.improved) parts.push(<span key="i" className="text-[var(--color-positive)]">выросли у {s.improved}</span>);
  if (s.noChange) parts.push(<span key="n">без изм. {s.noChange}</span>);
  if (s.notEnoughData) parts.push(<span key="d">мало данных {s.notEnoughData}</span>);
  if (s.pending) parts.push(<span key="p" className="text-[var(--color-text-muted)]">ждут замера {s.pending} (с {fmtShortDate(s.measureFrom)})</span>);
  if (s.absent) parts.push(<span key="x" className="text-[var(--color-text-muted)]">не были {s.absent}</span>);
  if (s.unmarked) parts.push(<span key="u" className="text-[var(--color-text-muted)]">посещение не отмечено {s.unmarked}</span>);
  return (
    <p className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[13px]">
      {parts.map((p, i) => <span key={i} className="inline-flex items-center gap-2">{i > 0 && <span aria-hidden className="text-[var(--color-text-muted)]">·</span>}{p}</span>)}
    </p>
  );
}
