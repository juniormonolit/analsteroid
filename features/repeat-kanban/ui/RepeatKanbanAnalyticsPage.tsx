'use client';
// «Аналитика канбана повторных» v1 (владелец 20.10: «что у нас по отчёту по канбану, где его
// смотреть?»): кто что делал за день · проработанность пула по отделам (ежедневные снимки в
// 23:30 МСК) · журнал действий. Данные копятся с 20.10 — динамика растёт по дням.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { taskUrl } from '../engine/config';
import type { KanbanAnalytics, DeptDay } from '../engine/analytics';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const moneyShort = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} млн ₽` : n >= 1000 ? `${Math.round(n / 1000)} тыс. ₽` : `${rub.format(n)} ₽`);
const todayMsk = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const fmtD = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('.');
const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;

const EVENT_LABEL: Record<string, string> = {
  deal_task_created: 'Сделка + задача',
  deal_returned_from_reject: 'Сделка из отказа + задача',
  task_created: 'Задача в сделку',
  task_comment_posted: 'Комментарий в чат задачи',
  reject_reviewed: 'Разобран отказ',
  rejected_direct: 'Сразу в брак',
  hidden: 'Скрыт из пула',
  unhidden: 'Возвращён в пул',
  reject_cleared: 'Снят брак',
};
const MAIN_TYPES = ['deal_task_created', 'deal_returned_from_reject', 'task_created', 'reject_reviewed', 'rejected_direct', 'hidden'] as const;

/** Мини-линия «проработано %» по дням для отдела. */
function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="text-[11px] text-[var(--color-text-muted)]">мало данных</span>;
  const w = 90, h = 24, max = 100;
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - (p / max) * h).toFixed(1)}`).join(' ');
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden><path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="2" /></svg>;
}

const cell = 'whitespace-nowrap px-2 py-1.5 text-right tabular-nums';
const head = 'whitespace-nowrap px-2 py-1.5 text-right text-[11.5px] font-medium text-[var(--color-text-muted)]';

export function RepeatKanbanAnalyticsPage() {
  const [date, setDate] = useState(todayMsk());
  const { data, isLoading, error } = useQuery<KanbanAnalytics>({
    queryKey: ['repeat-kanban-analytics', date],
    queryFn: async () => {
      const r = await fetch(`/api/repeat-kanban/analytics?date=${date}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Ошибка');
      return j;
    },
  });

  // Последний снимок по отделам + линия за 30 дней.
  const depts = useMemo(() => {
    const rows = data?.depts ?? [];
    const lastDate = rows[0]?.date ?? null;
    const last = rows.filter(r => r.date === lastDate);
    const series = new Map<string, DeptDay[]>();
    for (const r of [...rows].reverse()) { const l = series.get(r.department) ?? []; l.push(r); series.set(r.department, l); }
    return { lastDate, last: last.sort((a, b) => b.total - a.total), series };
  }, [data]);
  const sumLast = depts.last.reduce((s, r) => ({ total: s.total + r.total, pool: s.pool + r.pool, actions: s.actions + r.actions }), { total: 0, pool: 0, actions: 0 });

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <Link href="/repeat-kanban" className="inline-flex min-h-11 items-center gap-1 text-sm text-[var(--color-accent)] hover:underline"><ArrowLeft size={14} /> Канбан</Link>
            <h1 className="text-xl font-semibold">Аналитика канбана повторных</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Журнал действий и ежедневные снимки (23:30 МСК) копятся с 20.10.2026 — динамика растёт по дням.</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            День
            <input type="date" value={date} max={todayMsk()} onChange={e => e.target.value && setDate(e.target.value)}
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base sm:text-sm" />
          </label>
        </header>
        {error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{(error as Error).message}</div>}
        {isLoading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Загружаю…</div>}

        {/* 1. Кто что делал за день. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Кто что делал · {fmtD(date)}</h2>
          {data && data.actors.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">За этот день действий в канбане не было.</div> : (
            <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
              <table className="w-full min-w-[760px] text-sm">
                <thead><tr className="border-b border-[var(--color-border)]">
                  <th className={`${head} text-left`}>Кто</th><th className={head}>Всего</th><th className={head}>Заказчиков</th>
                  {MAIN_TYPES.map(t => <th key={t} className={head}>{EVENT_LABEL[t]}</th>)}
                  <th className={head}>Последнее</th>
                </tr></thead>
                <tbody>
                  {(data?.actors ?? []).map(a => (
                    <tr key={a.actor} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-2 py-1.5"><div className="font-medium">{a.actor}</div>{a.role && <div className="text-[11px] text-[var(--color-text-muted)]">{a.role}</div>}</td>
                      <td className={`${cell} font-bold`}>{a.total}</td><td className={cell}>{a.clients}</td>
                      {MAIN_TYPES.map(t => <td key={t} className={cell}>{a.byType[t] ?? '—'}</td>)}
                      <td className={cell}>{fmtTime(a.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 2. Проработанность пула по отделам — по ежедневным снимкам. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Проработанность пула по отделам{depts.lastDate ? ` · снимок ${fmtD(depts.lastDate)}` : ''}</h2>
          {!depts.lastDate ? <div className="text-sm text-[var(--color-text-muted)]">Снимков ещё нет — первый появится в 23:30 МСК.</div> : (
            <>
              <div className="text-sm text-[var(--color-text-secondary)]">
                Всего проработано <b>{sumLast.total ? Math.round(((sumLast.total - sumLast.pool) / sumLast.total) * 100) : 0}%</b> ·
                в пуле {rub.format(sumLast.pool)} из {rub.format(sumLast.total)} заказчиков · действий за день {sumLast.actions}
              </div>
              <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
                <table className="w-full min-w-[900px] text-sm">
                  <thead><tr className="border-b border-[var(--color-border)]">
                    <th className={`${head} text-left`}>Отдел</th><th className={head} title="Доля заказчиков не в пуле среди всех, кроме брака">Проработано</th>
                    <th className={head} title="Строгая: скрытые и отказы на проверке — непроработанные">Строго</th><th className={head}>За 30 дн.</th>
                    <th className={head}>В пуле</th><th className={head}>Срочно</th><th className={head}>Потенциал пула</th><th className={head}>В дозвоне</th>
                    <th className={head}>В воронке</th><th className={head}>Скрыто</th><th className={head}>Действий</th><th className={head}>Задач созд./прин.</th>
                    <th className={head}>Ждут приёмки</th><th className={head}>Просрочено</th>
                  </tr></thead>
                  <tbody>
                    {depts.last.map(r => (
                      <tr key={r.department} className="border-b border-[var(--color-border)] last:border-0">
                        <td className="px-2 py-1.5"><div className="font-medium">{r.department}</div><div className="text-[11px] text-[var(--color-text-muted)]">{r.managers} менеджеров · {rub.format(r.total)} заказчиков</div></td>
                        <td className={`${cell} font-bold`}>{r.workedPct}%</td><td className={cell}>{r.workedPctStrict}%</td>
                        <td className="px-2 py-1.5"><Spark points={(depts.series.get(r.department) ?? []).map(x => x.workedPct)} /></td>
                        <td className={cell}>{rub.format(r.pool)}</td><td className={cell}>{rub.format(r.poolHot)}</td><td className={cell}>{moneyShort(r.poolPotential)}</td>
                        <td className={cell}>{rub.format(r.inWork)}</td><td className={cell}>{rub.format(r.funnel)}</td><td className={cell}>{rub.format(r.hidden)}</td>
                        <td className={cell}>{r.actions}</td><td className={cell}>{r.tasksCreated} / {r.tasksAccepted}</td>
                        <td className={cell} style={r.tasksControl ? { color: '#b45f06' } : undefined}>{r.tasksControl}</td>
                        <td className={cell} style={r.tasksOverdue ? { color: 'var(--color-negative)' } : undefined}>{r.tasksOverdue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {/* 3. Журнал. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Журнал · {fmtD(date)}</h2>
          {data && data.journal.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">Пусто.</div> : (
            <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
              {(data?.journal ?? []).map((j, i) => (
                <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                  <span className="w-12 shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtTime(j.ts)}</span>
                  <span className="font-medium">{j.actor}</span>
                  <span>{EVENT_LABEL[j.type] ?? j.type}{j.type === 'reject_reviewed' && j.payload.decision ? ` · ${j.payload.decision === 'brak' ? 'брак' : j.payload.decision === 'no_answer' ? 'недозвон' : 'вернуть менеджеру'}` : ''}</span>
                  {j.clientKey && <span className="text-[var(--color-text-muted)]">заказчик {j.clientKey}</span>}
                  {j.dealId && <a href={dealUrl(j.dealId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"><ExternalLink size={12} />#{j.dealId}</a>}
                  {j.taskId && <a href={taskUrl(j.taskId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"><ExternalLink size={12} />задача {j.taskId}</a>}
                  {typeof j.payload.comment === 'string' && j.payload.comment && <span className="min-w-0 basis-full truncate text-[12px] text-[var(--color-text-secondary)] sm:basis-auto">«{j.payload.comment}»</span>}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
