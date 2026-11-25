'use client';
// «Большой брат» → «Сигналы»: лента сигналов риска (отклонение от собственной нормы человека — только подсказка
// директору, никаких автодействий), реакция на сообщения бота, настройки еженедельного дайджеста.
import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { ROLE_LABEL } from '../../engine/daily/types';
import { SIGNAL_LABEL, type SignalKind, type SignalsResponse } from '../../engine/signals/types';
import { DateBar } from '../people/DateBar';
import { CARD, todayMsk } from '../people/shared';
import { BotReactionBlock } from './BotReactionBlock';
import { DigestSettingsBlock } from './DigestSettingsBlock';

const KIND_TONE: Record<SignalKind, string> = {
  no_signal: 'bg-red-500/15 text-red-700 dark:text-red-300',
  no_mono: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  activity_drop: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  night: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  export_spike: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
  new_surface: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
};
const KIND_OPTS = (Object.keys(SIGNAL_LABEL) as SignalKind[]).map(k => ({ value: k, label: SIGNAL_LABEL[k] }));
const fmtD = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short' });

export function SignalsPage() {
  const [date, setDate] = useUrlState('date', stringParam(''));
  const [kind, setKind] = useUrlState('kind', stringParam(''));
  const asOf = date || todayMsk();

  const { data, error, isLoading, isFetching } = useQuery<SignalsResponse, Error>({
    queryKey: ['big-brother-signals', asOf],
    queryFn: async () => {
      const r = await fetch(`/api/big-brother/signals?date=${asOf}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as SignalsResponse;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });
  const list = useMemo(() => (data?.signals ?? []).filter(s => !kind || s.kind === kind), [data, kind]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DateBar date={asOf} onChange={setDate} />
          <SearchSelect ariaLabel="Вид сигнала" options={KIND_OPTS} value={kind} onChange={setKind} allLabel="Все сигналы" className="min-h-11 max-w-full" />
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          Сигнал — отклонение от собственной нормы человека (его прошлые рабочие дни), а не вывод. Это подсказка присмотреться:
          сотруднику ничего не отправляется, автоматических действий нет. Проверка по уволенным за июль–ноябрь: хоть один сигнал за
          4–2 недели до увольнения был у 40%, у работающих за такие же 2 недели — у 15%.
          {data && (data.monoSince
            ? ` Сигналы по Монолитике (не заходит, ночь, выгрузки, новый способ входа) — по данным с ${fmtD(data.monoSince)}.`
            : ' Сигналы по Монолитике (не заходит, ночь, выгрузки, новый способ входа) включатся, когда накопится журнал входов.')}
          {isFetching && ' Обновляю…'}
        </p>
        {error && <div className={`${CARD} p-4 text-sm text-[var(--color-negative)]`}>{error.message}</div>}
        {isLoading && !data && <div className={`${CARD} p-4 text-sm text-[var(--color-text-muted)]`}>Ищу отклонения…</div>}
        {data && (list.length === 0 ? (
          <div className={`${CARD} p-4 text-sm text-[var(--color-text-muted)]`}>Отклонений нет — все в своей норме.</div>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {list.map(s => (
              <li key={`${s.personId}|${s.kind}`} className={`${CARD} flex min-w-0 flex-col gap-1 p-3`}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${KIND_TONE[s.kind]}`}>{SIGNAL_LABEL[s.kind]}</span>
                  <span className="text-xs text-[var(--color-text-muted)]">с {fmtD(s.since)}</span>
                </div>
                <Link href={`/big-brother/people?id=${s.personId}&date=${s.since}`}
                  className="inline-flex min-h-11 items-center self-start font-medium text-[var(--color-accent)] hover:underline">
                  {s.name}
                </Link>
                <div className="text-xs text-[var(--color-text-secondary)]">
                  {[ROLE_LABEL[s.role], s.departmentName, s.ropName && `РОП ${s.ropName}`].filter(Boolean).join(' · ')}
                </div>
                <div className="text-sm text-[var(--color-text)]">{s.detail}</div>
              </li>
            ))}
          </ul>
        ))}
      </section>

      {data && <BotReactionBlock bot={data.bot} />}
      <DigestSettingsBlock />
    </div>
  );
}
