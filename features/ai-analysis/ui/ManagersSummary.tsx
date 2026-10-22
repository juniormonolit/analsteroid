'use client';
// Сводка по менеджерам из отчётов ИИ-анализа (этап 2): доля «да» по 8 критериям, средний балл,
// нарушения. Последний отчёт по каждому заказчику за период; строка менеджера раскрывается в список
// заказчиков — клик открывает карточку клиента (там вкладка «ИИ-анализ» с самим отчётом).
import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import { ClientCardDrawer } from '@/features/client-module/ui/ClientCardDrawer';
import { CRITERIA_LABELS, VIOLATION_LABELS, type ViolationKind } from '../engine/parse';
import type { ManagerSummary } from '../engine/summary';

const PERIODS = [{ days: 30, label: '30 дней' }, { days: 90, label: '90 дней' }, { days: 365, label: 'Год' }];
const SHORT = ['Тип', 'Объект', 'Стадия', 'По цепочке', 'Ассортимент', 'Сроки', 'След. шаг', 'Причина отказа'];

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
/** Меньше стольких заказчиков — проценты случайны («0%» или «100%» от одного разговора). */
const MIN_RELIABLE = 3;
const tone = (v: number | null, n = MIN_RELIABLE) => (v === null || n < MIN_RELIABLE ? 'text-[var(--color-text-muted)]'
  : v < 0.4 ? 'text-[var(--color-negative)] font-semibold' : v < 0.7 ? 'text-[var(--color-warning,#b7791f)]' : 'text-[var(--color-positive)]');
const fmtD = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });

export function ManagersSummary() {
  const [days, setDays] = useState(90);
  const [open, setOpen] = useState<string | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [sort, setSort] = useState<'analyses' | 'score'>('analyses');
  const q = useQuery<{ managers: ManagerSummary[]; total: number; noManager: number }>({
    queryKey: ['ai-analysis-summary', days],
    queryFn: async () => {
      const r = await apiFetch(`/api/ai-analysis/summary?days=${days}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Ошибка загрузки');
      return j;
    },
  });

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex max-w-6xl min-w-0 flex-col gap-3 p-4">
        <div>
          <h1 className="text-[20px] font-bold">ИИ-анализ: сводка по менеджерам</h1>
          <p className="text-[13px] text-[var(--color-text-muted)]">
            По последнему отчёту каждого заказчика за период. Менеджер — тот, кто вёл больше всего разговоров с заказчиком.
            Процент — доля «да» по критерию среди звонков, где он применим (частично = половина).
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="tablist">
          {PERIODS.map(p => (
            <button key={p.days} type="button" role="tab" aria-selected={days === p.days} onClick={() => setDays(p.days)}
              className={`min-h-11 rounded-lg border px-3 text-[13.5px] ${days === p.days ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
              {p.label}
            </button>
          ))}
        </div>

        {q.isLoading && <div className="text-sm text-[var(--color-text-muted)]">Собираем сводку…</div>}
        {q.error && <div className="text-sm text-[var(--color-negative)]">{q.error instanceof Error ? q.error.message : 'Ошибка'}</div>}
        {q.data && q.data.managers.length === 0 && (
          <div className="text-sm text-[var(--color-text-muted)]">За период нет отчётов. Запустите анализ во вкладке «ИИ-анализ» карточки клиента.</div>
        )}
        {q.data && q.data.managers.length > 0 && (() => {
          const list = [...q.data.managers].sort((a, b) => sort === 'score'
            ? (a.avgScore ?? 2) - (b.avgScore ?? 2) : b.analyses - a.analyses);
          // «Все менеджеры»: взвешенно по числу заказчиков.
          const all = q.data.managers;
          const totalN = all.reduce((x, m) => x + m.analyses, 0);
          const wavg = (get: (m: ManagerSummary) => number | null) => {
            let sum = 0, w = 0;
            for (const m of all) { const v = get(m); if (v !== null) { sum += v * m.analyses; w += m.analyses; } }
            return w ? sum / w : null;
          };
          const total = { avgScore: wavg(m => m.avgScore), criteria: Array.from({ length: 8 }, (_, i) => wavg(m => m.criteria[i])) };
          return (
          <>
            <div className="text-[12.5px] text-[var(--color-text-muted)]">
              Заказчиков с отчётом: {q.data.total}{q.data.noManager ? ` (у ${q.data.noManager} менеджер не определился — старые отчёты)` : ''}.
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-[var(--color-text-muted)]">Сортировка:</span>
              {([['analyses', 'по числу заказчиков'], ['score', 'слабые сверху']] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}
                  className={`min-h-11 rounded-lg border px-3 ${sort === k ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>{l}</button>
              ))}
            </div>

            {/* Телефон: карточки вместо таблицы на 12 колонок */}
            <div className="flex flex-col gap-2 md:hidden">
              {list.map(m => {
                const worst = m.criteria.map((v, i) => ({ v, i })).filter(x => x.v !== null).sort((a, b) => a.v! - b.v!).slice(0, 3);
                const viol = Object.entries(m.violations) as [ViolationKind, number][];
                return (
                  <div key={m.manager} className="rounded-xl border border-[var(--color-border)] p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <b className="min-w-0 break-words text-[14px]">{m.manager}</b>
                      <span className={`text-[22px] font-bold tabular-nums ${tone(m.avgScore, m.analyses)}`}>{pct(m.avgScore)}</span>
                    </div>
                    <div className="text-[12px] text-[var(--color-text-muted)]">Заказчиков: {m.analyses}{m.analyses < MIN_RELIABLE ? ' · мало данных' : ''}</div>
                    {worst.length > 0 && <div className="mt-1 text-[12.5px]">Слабее всего: {worst.map(w => `${SHORT[w.i]} ${pct(w.v)}`).join(' · ')}</div>}
                    {viol.length > 0 && <div className="mt-1 text-[12.5px] text-[var(--color-negative)]">{viol.map(([k, n]) => `${VIOLATION_LABELS[k]} · ${n}`).join('; ')}</div>}
                    <button type="button" onClick={() => setOpen(open === m.manager ? null : m.manager)} className="mt-1 min-h-11 text-[13px] text-[var(--color-accent)]">
                      {open === m.manager ? 'Скрыть заказчиков' : 'Заказчики →'}
                    </button>
                    {open === m.manager && m.items.map(it => (
                      <button key={it.id} type="button" onClick={() => setCard(it.clientRef)} className="flex min-h-11 w-full flex-wrap items-center gap-x-2 text-left text-[13px]">
                        <span className="tabular-nums text-[var(--color-text-muted)]">{fmtD(it.createdAt)}</span>
                        <span className="text-[var(--color-accent)]">{it.clientRef.startsWith('k') ? 'Компания' : 'Контакт'} #{it.clientRef.slice(1)}</span>
                        <span className="tabular-nums">{pct(it.score)}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>

            <div className="scroll-x hidden rounded-xl border border-[var(--color-border)] md:block">
              <table className="w-full min-w-[900px] text-[12.5px]">
                <thead className="text-left text-[var(--color-text-muted)]">
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="px-2 py-2">Менеджер</th>
                    <th className="px-2">Заказчиков</th>
                    <th className="px-2">Балл</th>
                    {SHORT.map((s, i) => <th key={s} className="px-2" title={CRITERIA_LABELS[i]}>{s}</th>)}
                    <th className="px-2">Нарушения</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-2,transparent)] font-semibold">
                    <td className="px-2 py-2">Все менеджеры</td>
                    <td className="px-2 py-2 tabular-nums">{totalN}</td>
                    <td className={`px-2 py-2 tabular-nums ${tone(total.avgScore, totalN)}`}>{pct(total.avgScore)}</td>
                    {total.criteria.map((v, i) => <td key={i} className={`px-2 py-2 tabular-nums ${tone(v, totalN)}`}>{pct(v)}</td>)}
                    <td className="px-2 py-2" />
                  </tr>
                  {list.map(m => {
                    const viol = Object.entries(m.violations) as [ViolationKind, number][];
                    const isOpen = open === m.manager;
                    return (
                      <Fragment key={m.manager}>
                        <tr className="cursor-pointer border-b border-[var(--color-border)] align-top hover:bg-[var(--color-surface-2,transparent)]"
                          onClick={() => setOpen(isOpen ? null : m.manager)}>
                          <td className="px-2 py-2 font-semibold">
                            <span className="inline-flex items-center gap-1"><ChevronDown size={13} className={isOpen ? 'rotate-180' : ''} />{m.manager}</span>
                          </td>
                          <td className="px-2 py-2 tabular-nums">{m.analyses}{m.analyses < MIN_RELIABLE && <div className="text-[10.5px] font-normal text-[var(--color-text-muted)]">мало данных</div>}</td>
                          <td className={`px-2 py-2 tabular-nums ${tone(m.avgScore, m.analyses)}`}>{pct(m.avgScore)}</td>
                          {m.criteria.map((v, i) => <td key={i} className={`px-2 py-2 tabular-nums ${tone(v, m.analyses)}`}>{pct(v)}</td>)}
                          <td className="px-2 py-2">
                            {viol.length === 0 ? <span className="text-[var(--color-text-muted)]">—</span>
                              : viol.map(([k, n]) => (
                                <span key={k} className="mb-1 mr-1 inline-block rounded bg-[color-mix(in_srgb,var(--color-negative)_10%,transparent)] px-1.5 text-[11.5px] text-[var(--color-negative)]">
                                  {VIOLATION_LABELS[k]} · {n}
                                </span>
                              ))}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-[var(--color-border)]">
                            <td colSpan={12} className="px-2 py-2">
                              <div className="flex flex-col gap-1">
                                {m.items.map(it => (
                                  <button key={it.id} type="button" onClick={() => setCard(it.clientRef)}
                                    className="flex min-h-11 flex-wrap items-center gap-x-3 rounded-lg px-2 text-left hover:bg-[var(--color-surface-2,transparent)]">
                                    <span className="tabular-nums text-[var(--color-text-muted)]">{fmtD(it.createdAt)}</span>
                                    <span className="text-[var(--color-accent)]">{it.clientRef.startsWith('k') ? 'Компания' : 'Контакт'} #{it.clientRef.slice(1)}</span>
                                    <span className="tabular-nums">балл {pct(it.score)}</span>
                                    {it.violations.map(k => <span key={k} className="text-[11.5px] text-[var(--color-negative)]">{VIOLATION_LABELS[k]}</span>)}
                                  </button>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
              Колонки: {CRITERIA_LABELS.map((l, i) => `${SHORT[i]} — ${l.toLowerCase()}`).join('; ')}.
              Цвет: красный — меньше 40%, жёлтый — 40–70%, зелёный — больше 70%; при «мало данных» (меньше {MIN_RELIABLE} заказчиков) — серый.
            </div>
          </>
          );
        })()}
      </div>
      {card && (
        <ClientCardDrawer
          contactId={card.startsWith('c') ? card.slice(1) : undefined}
          companyId={card.startsWith('k') ? card.slice(1) : undefined}
          onClose={() => setCard(null)} />
      )}
    </div>
  );
}
