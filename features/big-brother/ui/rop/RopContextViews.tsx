'use client';
// «Большой брат» → «РОПы»: контекст рядом с рейтингом — «Отчёт → задача», «Внимание», «Ритм» (GET /api/big-brother/rop/context)
// и «Лаг» (GET /api/big-brother/rop/lag). Это не баллы: в рейтинг не суммируется (подписано в каждом блоке).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SortableTh } from '@/components/ui/SortableTh';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import type { AttentionRow, LagPoint, RopContextResponse, RopLagResponse } from '../../engine/rop/types';
import { usePeriod } from './PeriodBar';
import { fmtDate, fmtInt, fmtMoney, fmtOne, fmtPct } from './format';

const BOX = 'rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm';
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 7:00–21:00 МСК

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `Ошибка ${r.status}`);
  return j as T;
}

export function useRopContext(blind: string) {
  const { from, to } = usePeriod();
  return useQuery<RopContextResponse, Error>({
    queryKey: ['big-brother-rop-context', from, to, blind],
    queryFn: () => getJson(`/api/big-brother/rop/context?from=${from}&to=${to}&blind=${blind}`),
    staleTime: 60_000,
    placeholderData: prev => prev,
  });
}

function State({ q }: { q: { error: Error | null; isLoading: boolean; data?: unknown } }) {
  if (q.error) return <div className={`${BOX} text-[var(--color-negative)]`}>{q.error.message}</div>;
  if (q.isLoading && !q.data) return <div className={`${BOX} text-[var(--color-text-muted)]`}>Читаю журнал активности…</div>;
  return null;
}

function Notes({ notes }: { notes: string[] }) {
  return <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-text-muted)]">{notes.map(n => <li key={n}>{n}</li>)}</ul>;
}

// ── «Отчёт → задача» ──────────────────────────────────────────────────────────────────────────

type R2TKey = 'name' | 'tasks' | 'origin' | 'heuristic' | 'blind' | 'beforeJournal' | 'informedPct';

export function ReportToTaskView() {
  const q = useRopContext('2');
  const [sort, setSort] = useState<{ key: R2TKey; desc: boolean }>({ key: 'tasks', desc: true });
  const rows = useMemo(() => {
    const list = [...(q.data?.reportToTask ?? [])];
    list.sort((a, b) => {
      if (sort.key === 'name') { const c = a.name.localeCompare(b.name, 'ru'); return sort.desc ? -c : c; }
      const x = a[sort.key] ?? -1, y = b[sort.key] ?? -1;
      return sort.desc ? y - x : x - y;
    });
    return list;
  }, [q.data, sort]);
  const on = (key: R2TKey) => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }));
  const th = (key: R2TKey, label: string, title?: string) => (
    <SortableTh key={key} label={label} title={title} align={key === 'name' ? 'left' : 'right'} sticky={key === 'name'}
      active={sort.key === key} dir={sort.desc ? 'desc' : 'asc'} onClick={() => on(key)} />
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-[var(--color-text-muted)]">
        Ставит ли РОП задачи «по цифрам»: из строки отчёта / карточки менеджера или сразу после их просмотра — против «вслепую».
        История до появления источника задачи — по эвристике (просмотр за 30 мин до постановки).
      </p>
      <State q={q} />
      {q.data && (
        <div className="scroll-x rounded-xl border border-[var(--color-border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr>
              {th('name', 'РОП')}
              {th('tasks', 'Задач')}
              {th('origin', 'Из отчёта / карточки', 'Поставлена из строки отчёта, дрилла по сделке или карточки менеджера (источник записан)')}
              {th('heuristic', 'После просмотра', 'Эвристика: за 30 мин до постановки смотрел отчёт или карточку этого менеджера')}
              {th('blind', 'Вслепую', 'В журнале нет просмотра отчёта или карточки менеджера за 30 мин до постановки')}
              {th('beforeJournal', 'До журнала', 'Поставлена до начала журнала активности — не классифицируется')}
              {th('informedPct', 'Доля «по цифрам»', '(из отчёта + после просмотра) / задач после начала журнала')}
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.ropId} className="border-t border-[var(--color-border)]">
                  <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-2 text-left font-medium text-[var(--color-text)]">{r.name}</td>
                  {[r.tasks, r.origin, r.heuristic, r.blind, r.beforeJournal].map((v, i) => (
                    <td key={i} className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[var(--color-text)]">{fmtInt(v)}</td>
                  ))}
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[var(--color-text)]">{fmtPct(r.informedPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Notes notes={q.data.notes} />}
    </div>
  );
}

// ── «Внимание» ────────────────────────────────────────────────────────────────────────────────

const BLIND_OPTS = [1, 2, 3, 4, 6, 8].map(n => ({ value: String(n), label: `Не открыт ${n} нед.` }));

export function AttentionView() {
  const [blind, setBlind] = useUrlState('blind', stringParam('2'));
  const [ropId, setRop] = useUrlState('rop', stringParam(''));
  const q = useRopContext(blind);
  const list = q.data?.attention ?? [];
  const opts = list.map(a => ({ value: a.ropId, label: a.name, hint: `слепых зон ${a.blindCount}, с просадкой ${a.blindWithDrop}` }));
  const cur: AttentionRow | undefined = list.find(a => a.ropId === ropId) ?? list[0];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-[var(--color-text-muted)]">
        Кого из подчинённых РОП открывает: карточка менеджера и дрилл отчёта по нему. Слепая зона — не открыт N недель; красным —
        при просадке продаж больше 20 % к предыдущему такому же периоду.
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SearchSelect ariaLabel="РОП" options={opts} value={cur?.ropId ?? ''} onChange={setRop} placeholder="РОП" className="min-h-11 max-w-full" />
        <SearchSelect ariaLabel="Порог слепой зоны" options={BLIND_OPTS} value={blind} onChange={setBlind} className="min-h-11 max-w-full" />
      </div>
      <State q={q} />
      {q.data && list.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-2">
          {list.map(a => (
            <button key={a.ropId} type="button" onClick={() => setRop(a.ropId)} aria-pressed={a.ropId === cur?.ropId}
              className={`min-h-11 rounded-lg border px-3 text-left text-xs ${a.ropId === cur?.ropId ? 'border-[var(--color-accent)] bg-[var(--color-bg-surface)]' : 'border-[var(--color-border)]'}`}>
              <span className="block font-medium text-[var(--color-text)]">{a.name}</span>
              <span className="text-[var(--color-text-muted)]">слепых {a.blindCount}/{a.subs.length}</span>
              {a.blindWithDrop > 0 && <span className="text-[var(--color-negative)]"> · с просадкой {a.blindWithDrop}</span>}
            </button>
          ))}
        </div>
      )}
      {cur && (
        <div className="scroll-x rounded-xl border border-[var(--color-border)]">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[var(--color-table-header)] text-xs text-[var(--color-text-muted)]">
              <tr>
                <th scope="col" className="sticky left-0 z-10 bg-[var(--color-table-header)] px-2 py-2 text-left">Менеджер</th>
                <th scope="col" className="px-2 py-2 text-right">Последний просмотр</th>
                <th scope="col" className="px-2 py-2 text-right" title="Открытий карточки за период">Карточка</th>
                <th scope="col" className="px-2 py-2 text-right" title="Дриллов отчёта по менеджеру за период">Дрилл</th>
                <th scope="col" className="px-2 py-2 text-right">Продажи</th>
                <th scope="col" className="px-2 py-2 text-right" title="К предыдущему такому же периоду">Динамика</th>
              </tr>
            </thead>
            <tbody>
              {cur.subs.map(s => {
                const dyn = s.salesNow != null && s.salesPrev ? s.salesNow / s.salesPrev - 1 : null;
                const alarm = s.blind && s.drop;
                return (
                  <tr key={s.id} className={`border-t border-[var(--color-border)] ${alarm ? 'bg-[color-mix(in_srgb,var(--color-negative)_8%,transparent)]' : ''}`}>
                    <td className={`sticky left-0 z-10 px-2 py-2 text-left ${alarm ? 'bg-[color-mix(in_srgb,var(--color-negative)_8%,var(--color-bg))]' : 'bg-[var(--color-bg)]'} text-[var(--color-text)]`}>{s.name}</td>
                    <td className={`whitespace-nowrap px-2 py-2 text-right tabular-nums ${s.blind ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>
                      {s.lastSeenAt ? fmtDate(s.lastSeenAt) : 'не открывал'}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[var(--color-text)]">{fmtInt(s.views)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[var(--color-text)]">{fmtInt(s.drills)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[var(--color-text)]">{fmtMoney(s.salesNow)}</td>
                    <td className={`whitespace-nowrap px-2 py-2 text-right tabular-nums ${s.drop ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>
                      {dyn == null ? '—' : `${dyn > 0 ? '+' : ''}${fmtPct(dyn)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Notes notes={q.data.notes} />}
    </div>
  );
}

// ── «Ритм» ────────────────────────────────────────────────────────────────────────────────────

export function RhythmView() {
  const q = useRopContext('2');
  const [ropId, setRop] = useUrlState('rop', stringParam(''));
  const list = q.data?.rhythm ?? [];
  const cur = list.find(r => r.ropId === ropId) ?? list[0];
  const max = Math.max(1, ...(cur?.grid.flat() ?? [0]));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-[var(--color-text-muted)]">
        Когда РОП смотрит отчёты и карточки менеджеров (МСК): день недели × час. «Подготовка» — был просмотр за 3 ч до сессии Задачника.
      </p>
      <SearchSelect ariaLabel="РОП" options={list.map(r => ({ value: r.ropId, label: r.name, hint: `просмотров ${r.total}` }))}
        value={cur?.ropId ?? ''} onChange={setRop} placeholder="РОП" className="min-h-11 max-w-full" />
      <State q={q} />
      {cur && (
        <>
          <p className="text-sm text-[var(--color-text)]">
            Просмотров за период: <b>{fmtInt(cur.total)}</b>. Сессий Задачника: <b>{fmtInt(cur.sessions)}</b>
            {cur.sessions > 0 && <>, с подготовкой — <b>{fmtInt(cur.sessionsPrepared)}</b></>}.
          </p>
          <div className="scroll-x">
            <table className="text-xs" aria-label="Просмотры по дням и часам">
              <thead><tr>
                <th scope="col" className="sticky left-0 z-10 bg-[var(--color-bg)] px-1" />
                {HOURS.map(h => <th key={h} scope="col" className="px-0.5 font-normal text-[var(--color-text-muted)]">{h}</th>)}
              </tr></thead>
              <tbody>
                {DAYS.map((d, i) => (
                  <tr key={d}>
                    <th scope="row" className="sticky left-0 z-10 bg-[var(--color-bg)] px-1 text-left font-normal text-[var(--color-text-muted)]">{d}</th>
                    {HOURS.map(h => {
                      const n = cur.grid[i][h];
                      return (
                        <td key={h} className="p-0.5">
                          <div title={`${d} ${h}:00 — ${n}`} className="h-6 w-6 rounded-sm border border-[var(--color-border)]"
                            style={{ background: n ? `color-mix(in srgb, var(--color-accent) ${Math.round(20 + (n / max) * 80)}%, transparent)` : undefined }} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {q.data && <Notes notes={q.data.notes} />}
    </div>
  );
}

// ── «Лаг» ─────────────────────────────────────────────────────────────────────────────────────

const LAG_OPTS = [2, 3, 4].map(n => ({ value: String(n), label: `Через ${n} нед.` }));

export function LagView() {
  const [lag, setLag] = useUrlState('lag', stringParam('2'));
  const q = useQuery<RopLagResponse, Error>({
    queryKey: ['big-brother-rop-lag', lag],
    queryFn: () => getJson(`/api/big-brother/rop/lag?lag=${lag}`),
    staleTime: 10 * 60_000,
    placeholderData: prev => prev,
  });
  const pts = useMemo(() => (q.data?.points ?? []).map(p => ({ ...p, y: p.y * 100 })), [q.data]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 text-sm text-[var(--color-text)]">
        <b>Корреляция, не рейтинг.</b> РОПов мало, недели одного РОПа связаны между собой, продажи зависят от многого — по этой
        картинке нельзя оценивать конкретного РОПа и нельзя суммировать её в балл.
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span className="text-[var(--color-text-muted)]">Задачи РОПа в неделю N × продажи отдела</span>
        <SearchSelect ariaLabel="Лаг" options={LAG_OPTS} value={lag} onChange={setLag} className="min-h-11 max-w-full" />
        {q.data && (
          <span className="text-[var(--color-text-muted)]">
            точек {q.data.points.length}, РОПов {q.data.rops}, r = {q.data.r == null ? '—' : q.data.r.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
          </span>
        )}
      </div>
      <State q={q} />
      {q.isLoading && !q.data && null}
      {q.data && (
        <div className="h-80 w-full min-w-0 rounded-xl border border-[var(--color-border)] p-2">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" name="Задач на подчинённого" tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }} tickFormatter={v => fmtOne(v)} />
              <YAxis type="number" dataKey="y" name="Продажи" width={52} tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }} tickFormatter={v => `${v}%`} />
              <ReferenceLine y={0} stroke="var(--color-text-muted)" />
              <Tooltip cursor={{ strokeDasharray: '4 4' }} content={({ payload }) => {
                const p = payload?.[0]?.payload as LagPoint | undefined;
                if (!p) return null;
                return (
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs shadow">
                    <div className="font-semibold text-[var(--color-text)]">{p.name}</div>
                    <div className="text-[var(--color-text-muted)]">неделя с {fmtDate(`${p.week}T12:00:00Z`)}: {fmtOne(p.x)} задач на подчинённого</div>
                    <div className="text-[var(--color-text-muted)]">продажи через {lag} нед.: {p.y > 0 ? '+' : ''}{fmtOne(p.y)}%</div>
                  </div>
                );
              }} />
              <ZAxis range={[48, 48]} />
              <Scatter data={pts} fill="var(--color-accent)" fillOpacity={0.6} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
      {q.data && <Notes notes={q.data.notes} />}
    </div>
  );
}
