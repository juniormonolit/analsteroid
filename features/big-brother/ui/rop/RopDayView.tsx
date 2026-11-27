'use client';
// «Большой брат» → «РОПы» → «День РОПа» (собрание 26.11): «что сделал Руденко сегодня» за два клика — вкладка «РОПы»
// открывается на этом виде со списком руководителей за сегодня, клик по человеку — его день: итог одной строкой
// (каждое число — фильтр списка), события по времени со ссылками на задачу / сделку, команда за день, лента по минутам.
// GET /api/big-brother/rop/day?date&id → RopDayResponse. Состояние — в URL (?date, ?rop), «назад» возвращает к списку.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import type { PeopleResponse, PersonDayResponse } from '../../engine/daily/types';
import type { RopDayItem, RopDayKind, RopDayPerson, RopDayResponse, RopDaySummary } from '../../engine/rop/types';
import { DateBar } from '../people/DateBar';
import { DayTimeline } from '../people/DayTimeline';
import { CARD, callsOf, dealsOf, fmtDateLong, fmtMin, fmtTime, tasksOf, todayMsk } from '../people/shared';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j as T;
}

const KIND_DOT: Record<RopDayKind, string> = {
  task_set: 'bg-violet-500', training: 'bg-fuchsia-500', task_done: 'bg-slate-400', task_accept: 'bg-emerald-500',
  task_return: 'bg-orange-500', meeting: 'bg-sky-500', kanban: 'bg-amber-400', calls: 'bg-teal-500',
};

/** Части итога дня: [ключ фильтра, текст]. Нулевые не показываются. */
function summaryParts(s: RopDaySummary): [RopDayKind, string][] {
  const out: [RopDayKind, string][] = [];
  if (s.set - s.training) out.push(['task_set', `поставил ${s.set - s.training}`]);
  if (s.training) out.push(['training', `на обучение ${s.training}`]);
  if (s.accepted) out.push(['task_accept', `проверил ${s.accepted}`]);
  if (s.done) out.push(['task_done', `закрыл ${s.done}`]);
  if (s.returned) out.push(['task_return', `вернул ${s.returned}`]);
  if (s.meetings) out.push(['meeting', `провёл ${s.meetings} ${plural(s.meetings, 'разбор', 'разбора', 'разборов')}${s.meetingMin ? ` (${fmtMin(s.meetingMin)})` : ''}`]);
  if (s.calls) out.push(['calls', `${s.calls} ${plural(s.calls, 'звонок', 'звонка', 'звонков')}, ${fmtMin(s.callMin)}`]);
  if (s.kanban) out.push(['kanban', `в канбанах ${s.kanban}`]);
  return out;
}

function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 100, b = n % 10;
  if (a >= 11 && a <= 14) return many;
  return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

const weight = (s: RopDaySummary) => s.set + s.accepted + s.done + s.returned + s.meetings * 2 + s.kanban;

export function RopDayView() {
  const [dateRaw, setDate] = useUrlState('date', stringParam(''));
  const [rop, setRop] = useUrlState('rop', { ...stringParam(''), mode: 'push' });
  const date = dateRaw || todayMsk();
  const q = useQuery<RopDayResponse, Error>({
    queryKey: ['big-brother-rop-day', date, rop],
    queryFn: () => getJson(`/api/big-brother/rop/day?date=${date}${rop ? `&id=${rop}` : ''}`),
    staleTime: 60_000,
    placeholderData: prev => (prev?.date === date ? { ...prev, detail: prev.detail?.person.id === rop ? prev.detail : null } : undefined),
  });
  const d = q.data;
  const options = useMemo(() => (d?.rops ?? []).map(p => ({
    value: p.id, label: p.name, hint: [p.role, ...p.deptNames].filter(Boolean).join(' · '),
  })), [d]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {rop && (
          <button type="button" onClick={() => setRop('')}
            className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
            <ArrowLeft size={16} /> Все
          </button>
        )}
        <DateBar date={date} onChange={setDate} />
        <SearchSelect ariaLabel="Руководитель" options={options} value={rop} onChange={setRop} allLabel="Все руководители"
          searchable className="min-h-11 w-full max-w-full sm:w-72" />
      </div>
      {q.error && <div className={`${CARD} p-4 text-sm text-[var(--color-negative)]`}>{q.error.message}</div>}
      {q.isLoading && !d && <div className={`${CARD} p-4 text-sm text-[var(--color-text-muted)]`}>Собираю день руководителей…</div>}
      {d && d.failed.length > 0 && (
        <p className="text-xs text-[var(--color-negative)]">Не прочитались: {d.failed.join(', ')} — картина дня неполная.</p>
      )}
      {d && (rop
        ? (d.detail ? <RopDetail person={d.detail.person} items={d.detail.items} date={date} notes={d.notes} /> : q.isFetching
          ? <div className={`${CARD} p-4 text-sm text-[var(--color-text-muted)]`}>Собираю день…</div>
          : <div className={`${CARD} p-4 text-sm text-[var(--color-text-muted)]`}>Руководитель не найден.</div>)
        : <RopList rops={d.rops} date={date} onOpen={setRop} />)}
    </div>
  );
}

function RopList({ rops, date, onOpen }: { rops: RopDayPerson[]; date: string; onOpen: (id: string) => void }) {
  const sorted = useMemo(() => [...rops].sort((a, b) => weight(b.summary) - weight(a.summary) || b.summary.calls - a.summary.calls
    || a.name.localeCompare(b.name, 'ru')), [rops]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-[var(--color-text-muted)]">
        {fmtDateLong(date)} Нажмите на руководителя — что он сделал за день, по времени, со ссылками на задачи и сделки.
      </p>
      <ul className={`${CARD} min-w-0`}>
        {sorted.map(p => {
          const parts = summaryParts(p.summary);
          return (
            <li key={p.id} className="border-t border-[var(--color-border)] first:border-t-0">
              <button type="button" onClick={() => onOpen(p.id)}
                className="flex min-h-11 w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-[var(--color-bg-hover)]">
                <span className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-[var(--color-accent)]">{p.name}</span>
                  <span className="min-w-0 truncate text-xs text-[var(--color-text-muted)]">
                    {[p.role, p.deptNames.join(', '), p.teamSize ? `команда ${p.teamSize}` : null].filter(Boolean).join(' · ')}
                  </span>
                  {p.firstAt && <span className="ml-auto text-xs tabular-nums text-[var(--color-text-muted)]">{fmtTime(p.firstAt)}–{fmtTime(p.lastAt)}</span>}
                </span>
                <span className={`text-sm ${parts.length ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>
                  {parts.length ? parts.map(x => x[1]).join(', ') : 'ничего не видно: ни задач, ни разборов, ни звонков'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RopDetail({ person, items, date, notes }: { person: RopDayPerson; items: RopDayItem[]; date: string; notes: string[] }) {
  const [only, setOnly] = useState<RopDayKind | null>(null);
  const parts = summaryParts(person.summary);
  const shown = only ? items.filter(i => i.kind === only) : items;
  const nowIso = new Date().toISOString();

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-[var(--color-text)]">{person.name}</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {[person.role, person.deptNames.join(', '), person.teamSize ? `команда ${person.teamSize}` : null].filter(Boolean).join(' · ')}
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          {fmtDateLong(date)}{person.firstAt ? ` · первое действие ${fmtTime(person.firstAt)}, последнее ${fmtTime(person.lastAt)}` : ''}
        </p>
      </div>

      <div className={`${CARD} min-w-0 p-3`}>
        <div className="mb-1 text-xs text-[var(--color-text-secondary)]">Итог дня — нажмите на число, чтобы оставить в списке только это</div>
        {parts.length ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {parts.map(([k, text]) => (
              <button key={k} type="button" aria-pressed={only === k} onClick={() => setOnly(o => (o === k ? null : k))}
                className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm ${only === k
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                  : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${KIND_DOT[k]}`} />{text}
              </button>
            ))}
            {only && (
              <button type="button" onClick={() => setOnly(null)} className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                Показать всё
              </button>
            )}
          </div>
        ) : <p className="text-sm text-[var(--color-text-muted)]">За день не видно ни задач, ни разборов, ни звонков.</p>}
      </div>

      {shown.length > 0 && (
        <section className={`${CARD} min-w-0`}>
          <h3 className="px-3 pt-3 text-sm font-semibold text-[var(--color-text)]">События по времени</h3>
          <ul className="mt-2">
            {shown.map(it => (
              <li key={it.key} className={`flex min-w-0 gap-2 border-t border-[var(--color-border)] px-3 py-2 ${it.at > nowIso ? 'opacity-60' : ''}`}>
                <span className="w-11 shrink-0 pt-0.5 text-sm tabular-nums text-[var(--color-text-secondary)]">{fmtTime(it.at)}</span>
                <span aria-hidden className={`mt-2 inline-block h-2 w-2 shrink-0 rounded-full ${KIND_DOT[it.kind]}`} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm text-[var(--color-text)]">
                    {it.title}{it.who && <span className="text-[var(--color-text-secondary)]"> → {it.who}</span>}
                  </span>
                  {it.detail && <span className="break-words text-xs text-[var(--color-text-muted)]">{it.detail}</span>}
                  {it.links.length > 0 && (
                    <span className="flex flex-wrap gap-x-3">
                      {it.links.map(l => {
                        const ext = /^https?:/.test(l.href);
                        return (
                          <a key={l.href} href={l.href} target={ext ? '_blank' : undefined} rel={ext ? 'noopener noreferrer' : undefined}
                            className="inline-flex min-h-11 items-center gap-1 text-xs text-[var(--color-accent)] hover:underline sm:min-h-0 sm:py-0.5">
                            {l.label}{ext && <ExternalLink size={11} aria-hidden />}
                          </a>
                        );
                      })}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <TeamDay ropId={person.id} date={date} />
      <MinuteLine id={person.id} date={date} />

      <details className="text-xs text-[var(--color-text-muted)]">
        <summary className="min-h-11 cursor-pointer py-2 text-sm text-[var(--color-accent)]">Что и откуда здесь считается</summary>
        <ul className="list-disc space-y-1 pl-5">{notes.map(n => <li key={n}>{n}</li>)}</ul>
      </details>
    </div>
  );
}

/** Команда РОПа за день — из агрегата «Людей» (/api/big-brother/people), без нового источника. */
function TeamDay({ ropId, date }: { ropId: string; date: string }) {
  const q = useQuery<PeopleResponse, Error>({
    queryKey: ['big-brother-people', date],
    queryFn: () => getJson(`/api/big-brother/people?date=${date}`),
    staleTime: 60_000,
  });
  const team = (q.data?.people ?? []).filter(p => p.ropId === ropId && p.id !== ropId)
    .sort((a, b) => Number(!!b.day?.inWork) - Number(!!a.day?.inWork) || a.name.localeCompare(b.name, 'ru'));
  if (q.isLoading) return null;
  if (q.error) return <p className="text-xs text-[var(--color-negative)]">Команда: {q.error.message}</p>;
  if (!team.length) return null;
  const inWork = team.filter(p => p.day?.inWork).length;
  return (
    <section className={`${CARD} min-w-0`}>
      <h3 className="px-3 pt-3 text-sm font-semibold text-[var(--color-text)]">Команда за день <span className="font-normal text-[var(--color-text-muted)]">· в работе {inWork} из {team.length}</span></h3>
      <div className="scroll-x mt-2">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-left text-[var(--color-text-secondary)]">
              <th className="px-3 py-2 font-medium">Менеджер</th>
              <th className="px-3 py-2 font-medium">Первый — последний</th>
              <th className="px-3 py-2 text-right font-medium">Звонки</th>
              <th className="px-3 py-2 text-right font-medium">Сделки</th>
              <th className="px-3 py-2 text-right font-medium">Задачи</th>
            </tr>
          </thead>
          <tbody>
            {team.map(p => (
              <tr key={p.id} className="border-t border-[var(--color-border)]">
                <td className="px-3 py-1">
                  <a href={`/big-brother/people?id=${p.id}&date=${date}`} className="flex min-h-11 items-center gap-1.5 text-[var(--color-accent)] hover:underline">
                    <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${p.day?.inWork ? 'bg-emerald-500' : 'bg-[var(--color-border-strong)]'}`} />
                    {p.name}
                  </a>
                </td>
                <td className="px-3 py-1 tabular-nums text-[var(--color-text)]">
                  {p.day?.inWork ? `${fmtTime(p.day.firstSignalAt)} — ${fmtTime(p.day.lastSignalAt)}` : <span className="text-[var(--color-text-muted)]">нет сигнала</span>}
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-[var(--color-text)]">{callsOf(p.day?.counts)}</td>
                <td className="px-3 py-1 text-right tabular-nums text-[var(--color-text)]">{dealsOf(p.day?.counts)}</td>
                <td className="px-3 py-1 text-right tabular-nums text-[var(--color-text)]">{tasksOf(p.day?.counts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Лента по минутам — тот же DayTimeline, что на «Людях»; грузится, только когда раскрыли. */
function MinuteLine({ id, date }: { id: string; date: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery<PersonDayResponse, Error>({
    queryKey: ['big-brother-person-day', id, date],
    queryFn: () => getJson(`/api/big-brother/people/${id}/day?date=${date}`),
    staleTime: 60_000,
    enabled: open,
  });
  return (
    <details className={`${CARD} min-w-0 px-3`} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-[var(--color-text)]">Лента дня по минутам (звонки, сделки, Монолитика)</summary>
      <div className="pb-3">
        {q.isLoading && <p className="text-sm text-[var(--color-text-muted)]">Собираю ленту…</p>}
        {q.error && <p className="text-sm text-[var(--color-negative)]">{q.error.message}</p>}
        {q.data && <DayTimeline data={q.data} />}
      </div>
    </details>
  );
}
