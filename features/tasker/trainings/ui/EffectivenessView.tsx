'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { TrainingEffectMetricRow, TrainingEffectRow, TrainingEffectivenessResponse, TrainingManagersResponse } from '../types';
import { getJson } from './api';
import { addDaysKey, deltaTone, fmtDelta, mskDateKey } from './format';
import { ManagerTrainingHistory } from './ManagerTrainingHistory';

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
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Период">
        {PERIODS.map(d => (
          <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
            className={`min-h-11 rounded-lg px-3 text-sm ${days === d ? 'bg-[var(--color-bg-hover)] font-medium ring-1 ring-[var(--color-accent)]' : 'border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
            {d} дней
          </button>
        ))}
      </div>
      <p className="-mt-3 text-[12px] text-[var(--color-text-muted)]">
        Обучения, прошедшие за период. «Выросли» — доля посетивших с ростом связанных показателей среди тех, у кого хватило данных;
        прирост — среднее «после − до» у менеджеров против отдела за те же дни. Не отмеченные по посещению в оценку не идут.
      </p>

      {q.isLoading ? <p className="text-sm text-[var(--color-text-muted)]">Считаю…</p>
        : q.isError ? <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>
        : q.data && (q.data.byTrainer.length === 0
          ? <p className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">За период обучений не было.</p>
          : <>
              <EffectTable title="По тренерам" first="Тренер" rows={q.data.byTrainer} />
              <EffectTable title="По темам" first="Тема" rows={q.data.byTopic} />
              <MetricTable rows={q.data.byMetric} />
            </>)}

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
