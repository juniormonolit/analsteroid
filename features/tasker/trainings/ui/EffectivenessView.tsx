'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { TrainingEffectMetricRow, TrainingEffectRow, TrainingEffectivenessResponse, TrainingManagersResponse } from '../types';
import { getJson } from './api';
import { addDaysKey, deltaTone, fmtDelta, mskDateKey } from './format';
import { ManagerTrainingHistory } from './ManagerTrainingHistory';
import { TrainingTestsPeriod } from '../../tests/ui/TrainingTestsPeriod';

const PERIODS = [30, 90, 180, 365] as const;
const TH = 'whitespace-nowrap px-3 py-2 text-left text-[12px] font-medium text-[var(--color-text-muted)]';
const TD = 'whitespace-nowrap px-3 py-2 tabular-nums';

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

/**
 * Вкладка «Эффективность» на /tasker/trainings: свод по тренерам, темам и показателям за период + история менеджера.
 * Цифры — по видимым людям: тренер/админ — все, РОП — свои менеджеры, менеджер — он сам.
 */
export function EffectivenessView({ canPickManager, initialManager }: { canPickManager: boolean; initialManager: string | null }) {
  const [days, setDays] = useState<number>(90);
  const [manager, setManager] = useState(initialManager ?? '');
  const to = mskDateKey(new Date());
  const from = addDaysKey(to, -days);
  const q = useQuery({
    queryKey: ['tasker-trainings', 'effect', from, to],
    queryFn: () => getJson<TrainingEffectivenessResponse>(`/api/tasker/trainings/effectiveness?from=${from}&to=${to}`),
  });
  const managers = useQuery({
    queryKey: ['tasker-trainings-managers'],
    queryFn: () => getJson<TrainingManagersResponse>('/api/tasker/trainings/managers'),
    enabled: canPickManager,
    staleTime: 5 * 60_000,
  });
  const managerOptions = useMemo(
    () => (managers.data?.managers ?? []).map(m => ({ value: String(m.id), label: m.name, hint: m.departmentName })),
    [managers.data],
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {/* Сегментный период — как «Список» обучений. */}
        <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5" role="group" aria-label="Период">
          {PERIODS.map(d => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
              className={`min-h-10 rounded-md px-3 text-sm tabular-nums ${days === d ? 'bg-[var(--color-accent)] text-white' : 'hover:bg-[var(--color-bg-hover)]'}`}>
              {d} дн.
            </button>
          ))}
        </div>
        <details className="min-w-0 text-[12.5px] text-[var(--color-text-muted)]">
          <summary className="min-h-11 cursor-pointer content-center text-[var(--color-accent)]">Как считается</summary>
          <p className="max-w-2xl pb-2">
            Обучения, прошедшие за период. «Выросли» — доля посетивших с ростом связанных показателей среди тех, у кого хватило данных;
            прирост — среднее «после − до» у менеджеров против отдела за те же дни. Не отмеченные по посещению в оценку не идут.
          </p>
        </details>
      </div>

      {q.isLoading ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-busy>{[0, 1, 2, 3].map(i => <div key={i} className="h-20 animate-pulse rounded-xl bg-[var(--color-bg-surface)]" />)}</div>
        : q.isError ? <div className="rounded-xl bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{(q.error as Error).message} <button type="button" onClick={() => q.refetch()} className="ml-2 underline">Повторить</button></div>
        : q.data && (q.data.byTrainer.length === 0
          ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
              <p className="font-medium text-[var(--color-text)]">За {days} дней прошедших занятий нет</p>
              <p className="mt-1">Оценка появится после занятия: тренер отмечает, кто был, а через окно замера (обычно 7 дней) система
                сравнит показатели «до» и «после» и посчитает, у скольких вырос.</p>
            </div>
          )
          : <>
              <Kpis rows={q.data.byTrainer} metrics={q.data.byMetric} />
              <EffectTable title="По тренерам" first="Тренер" rows={q.data.byTrainer} />
              <EffectTable title="По темам" first="Тема" rows={q.data.byTopic} />
              <MetricTable rows={q.data.byMetric} />
            </>)}

      <TrainingTestsPeriod from={from} to={to} />

      <section className="flex min-w-0 flex-col gap-2">
        <h2 className="text-[15px] font-semibold">История обучений менеджера</h2>
        {canPickManager && (
          <SearchSelect options={managerOptions} value={manager} onChange={setManager} searchable
            placeholder={managers.isLoading ? 'Загружаю…' : 'Выберите менеджера'} searchPlaceholder="Поиск по имени или отделу"
            ariaLabel="Менеджер" className="min-h-11 w-full min-w-0 sm:max-w-sm" />
        )}
        {canPickManager
          ? manager ? <ManagerTrainingHistory managerId={Number(manager)} /> : null
          : <ManagerTrainingHistory managerId={null} />}
      </section>
    </div>
  );
}

/** Итог периода крупно — до таблиц: «обучено / замерено / выросли / прирост против отдела». */
function Kpis({ rows, metrics }: { rows: TrainingEffectRow[]; metrics: TrainingEffectMetricRow[] }) {
  const sum = (k: 'events' | 'people' | 'measured' | 'improved' | 'notEnoughData') => rows.reduce((s, r) => s + r[k], 0);
  const base = sum('measured') - sum('notEnoughData');
  const share = base > 0 ? sum('improved') / base : null;
  // Прирост против отдела показываем, только если показатель один (иначе складывать проценты и рубли нельзя).
  const one = metrics.length === 1 ? metrics[0] : null;
  const tiles: { label: string; value: string; hint?: string; tone?: string }[] = [
    { label: 'Занятий', value: String(sum('events')) },
    { label: 'Были на занятиях', value: String(sum('people')), hint: sum('people') > sum('measured') ? `ждут замера ${sum('people') - sum('measured')}` : undefined },
    { label: 'Выросли', value: pct(share), hint: base ? `${sum('improved')} из ${base}${base < 5 ? ' · мало для выводов' : ''}` : 'ещё нет замеров',
      tone: share !== null && share >= 0.5 ? 'text-[var(--color-positive)]' : undefined },
    one
      ? { label: 'Прирост против отдела', value: fmtDelta(one.avgDelta !== null && one.avgDeptDelta !== null ? one.avgDelta - one.avgDeptDelta : null, one.format), hint: one.label,
          tone: deltaTone(one.avgDelta !== null && one.avgDeptDelta !== null ? one.avgDelta - one.avgDeptDelta : null, one.higherIsBetter) }
      : { label: 'Показателей', value: String(metrics.length), hint: 'прирост — в таблице ниже' },
  ];
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map(t => (
        <div key={t.label} className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-[var(--color-bg-surface)] px-3 py-2.5">
          <span className="truncate text-[12px] text-[var(--color-text-muted)]">{t.label}</span>
          <span className={`text-xl font-semibold tabular-nums ${t.tone ?? ''}`}>{t.value}</span>
          {t.hint && <span className="truncate text-[11.5px] text-[var(--color-text-muted)]" title={t.hint}>{t.hint}</span>}
        </div>
      ))}
    </div>
  );
}

function Counts({ r }: { r: TrainingEffectRow }) {
  return (
    <>
      <td className={TD}>{r.events}</td>
      <td className={TD}>{r.people}</td>
      <td className={TD}>{r.measured}{r.people > r.measured ? <span className="text-[var(--color-text-muted)]"> / ждут {r.people - r.measured}</span> : null}</td>
      <td className={TD}>
        <b className={r.improvedShare !== null && r.improvedShare >= 0.5 ? 'text-[var(--color-positive)]' : ''}>{pct(r.improvedShare)}</b>
        <span className="text-[var(--color-text-muted)]"> ({r.improved} из {r.measured - r.notEnoughData}{r.notEnoughData ? `, мало данных ${r.notEnoughData}` : ''})</span>
      </td>
    </>
  );
}

function EffectTable({ title, first, rows }: { title: string; first: string; rows: TrainingEffectRow[] }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <div className="scroll-x rounded-lg border border-[var(--color-border)]">
        <table className="w-full min-w-[560px] text-[13px]">
          <thead className="border-b border-[var(--color-border)]">
            <tr><th className={TH}>{first}</th><th className={TH}>Обучений</th><th className={TH}>Были</th><th className={TH}>Замерено</th><th className={TH}>Выросли</th></tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map(r => (
              <tr key={r.key}><td className="max-w-[16rem] truncate px-3 py-2 font-medium" title={r.label}>{r.label}</td><Counts r={r} /></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricTable({ rows }: { rows: TrainingEffectMetricRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-[15px] font-semibold">По показателям</h2>
      <div className="scroll-x rounded-lg border border-[var(--color-border)]">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead className="border-b border-[var(--color-border)]">
            <tr>
              <th className={TH}>Показатель</th><th className={TH}>Обучений</th><th className={TH}>Были</th><th className={TH}>Замерено</th>
              <th className={TH}>Выросли</th><th className={TH}>Прирост менеджеров</th><th className={TH}>Отдел за те же дни</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map(r => (
              <tr key={r.key}>
                <td className="max-w-[16rem] truncate px-3 py-2 font-medium" title={r.label}>{r.label}</td>
                <Counts r={r} />
                <td className={`${TD} ${deltaTone(r.avgDelta, r.higherIsBetter)}`}>{fmtDelta(r.avgDelta, r.format)}</td>
                <td className={`${TD} ${deltaTone(r.avgDeptDelta, r.higherIsBetter)}`}>{fmtDelta(r.avgDeptDelta, r.format)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
