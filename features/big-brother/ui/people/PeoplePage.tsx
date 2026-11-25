'use client';
// «Большой брат» → «Люди»: список мониторимых (продажи + логисты) за дату → карточка человека (лента дня + календарь).
// Состояние в URL (?date, ?id) — карточку можно открыть ссылкой, «назад» в браузере возвращает к списку.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { ROLE_LABEL, type PeopleResponse, type PersonRole } from '../../engine/daily/types';
import { DateBar } from './DateBar';
import { PersonCard } from './PersonCard';
import { CARD, callsOf, dealsOf, fmtMin, fmtTime, servicesOf, tasksOf, todayMsk } from './shared';

const ROLE_OPTS = (Object.keys(ROLE_LABEL) as PersonRole[]).map(r => ({ value: r, label: ROLE_LABEL[r] }));
const STATUS_OPTS = [{ value: 'in', label: 'В работе' }, { value: 'none', label: 'Нет сигнала' }];

export function PeoplePage() {
  const [date, setDate] = useUrlState('date', stringParam(''));
  const [id, setId] = useUrlState('id', { ...stringParam(''), mode: 'push' });
  const day = date || todayMsk();

  if (id) return <PersonCard id={id} date={day} onDate={setDate} onBack={() => setId('')} />;
  return <PeopleList date={day} onDate={setDate} onOpen={setId} />;
}

function PeopleList({ date, onDate, onOpen }: { date: string; onDate: (d: string) => void; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [dept, setDept] = useUrlState('dept', stringParam(''));
  const [role, setRole] = useUrlState('role', stringParam(''));
  const [status, setStatus] = useUrlState('status', stringParam(''));

  const { data, error, isLoading, isFetching } = useQuery<PeopleResponse, Error>({
    queryKey: ['big-brother-people', date],
    queryFn: async () => {
      const r = await fetch(`/api/big-brother/people?date=${date}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as PeopleResponse;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });

  const deptOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of data?.people ?? []) if (p.departmentId) m.set(p.departmentId, p.departmentName ?? p.departmentId);
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.people ?? []).filter(p => (!dept || p.departmentId === dept) && (!role || p.role === role)
      && (!status || (status === 'in' ? p.day?.inWork : !p.day?.inWork))
      && (!needle || `${p.name} ${p.departmentName ?? ''} ${p.ropName ?? ''}`.toLowerCase().includes(needle)))
      .sort((a, b) => Number(!!b.day?.inWork) - Number(!!a.day?.inWork) || (b.day?.buckets ?? 0) - (a.day?.buckets ?? 0)
        || a.name.localeCompare(b.name, 'ru'));
  }, [data, q, dept, role, status]);
  const inWork = (data?.people ?? []).filter(p => p.day?.inWork).length;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DateBar date={date} onChange={onDate} />
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск: сотрудник, отдел, РОП"
          className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] sm:w-64 sm:text-sm" />
        <SearchSelect ariaLabel="Отдел" options={deptOpts} value={dept} onChange={setDept} allLabel="Все отделы" searchable className="min-h-11 max-w-full" />
        <SearchSelect ariaLabel="Роль" options={ROLE_OPTS} value={role} onChange={setRole} allLabel="Все роли" className="min-h-11 max-w-full" />
        <SearchSelect ariaLabel="Статус дня" options={STATUS_OPTS} value={status} onChange={setStatus} allLabel="Все" className="min-h-11 max-w-full" />
      </div>
      {data && (
        <p className="text-xs text-[var(--color-text-muted)]">
          В работе {inWork} из {data.people.length} · показано {rows.length}.{' '}
          {data.builtAt ? `Агрегат собран в ${fmtTime(data.builtAt)}.` : 'Агрегат за дату ещё не собран — посчитано сейчас.'}
          {' '}«В работе» — был хоть один сигнал: звонок, сделка, задача, действие в Монолитике.{isFetching && ' Обновляю…'}
        </p>
      )}
      {error && <div className={`${CARD} p-4 text-sm text-[var(--color-negative)]`}>{error.message}</div>}
      {isLoading && !data && !error && <div className={`${CARD} p-4 text-sm text-[var(--color-text-muted)]`}>Собираю активность…</div>}
      {data && (rows.length === 0 ? (
        <div className={`${CARD} p-4 text-sm text-[var(--color-text-muted)]`}>Никого не нашлось.</div>
      ) : (
        <div className="scroll-x rounded-xl border border-[var(--color-border)]">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-[var(--color-text-secondary)]">
                <th className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-2 font-medium">Сотрудник</th>
                <th className="px-2 py-2 font-medium">Первый — последний</th>
                <th className="px-2 py-2 text-right font-medium" title="Активное время в Монолитике">Монолитика</th>
                <th className="px-2 py-2 text-right font-medium" title="Действия в сервисах: Задачник, канбаны">Действия</th>
                <th className="px-2 py-2 text-right font-medium" title="Исходящие и принятые входящие">Звонки</th>
                <th className="px-2 py-2 text-right font-medium" title="Смены стадий и новые сделки">Сделки</th>
                <th className="px-2 py-2 text-right font-medium" title="Поставлено и закрыто задач в Битриксе">Задачи</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]">
                  <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-1.5">
                    <button type="button" onClick={() => onOpen(p.id)} className="flex min-h-11 flex-col items-start text-left">
                      <span className="flex items-center gap-1.5 font-medium text-[var(--color-accent)]">
                        <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${p.day?.inWork ? 'bg-emerald-500' : 'bg-[var(--color-border-strong)]'}`} />
                        {p.name}
                      </span>
                      <span className="max-w-[160px] truncate text-xs text-[var(--color-text-muted)] sm:max-w-[260px]">
                        {[ROLE_LABEL[p.role], p.departmentName].filter(Boolean).join(' · ')}
                      </span>
                    </button>
                  </td>
                  <td className="px-2 py-1.5 tabular-nums text-[var(--color-text)]">
                    {p.day?.inWork ? `${fmtTime(p.day.firstSignalAt)} — ${fmtTime(p.day.lastSignalAt)}` : <span className="text-[var(--color-text-muted)]">нет сигнала</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">{fmtMin(p.day?.monoMinutes ?? 0)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">{servicesOf(p.day?.counts)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">{callsOf(p.day?.counts)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">{dealsOf(p.day?.counts)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">{tasksOf(p.day?.counts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
