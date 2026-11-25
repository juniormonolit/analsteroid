'use client';
// Блок «Задача» в карточке (владелец 25.11: «информацию из задачи переносить целиком — чтобы в Битрикс не хотелось»;
// спецификация Fable 25.11, раздел 4). Поля запроса (описание задачи + сделка + запрос логисту), комментарий менеджера
// цитатой, товары одной таблицей-сравнением «при постановке → сейчас в сделке» вместо двух таблиц и плашки
// «товары отличаются», цена конкурента. Данные — details.brief (engine/taskBrief.ts) и details.dealProducts.
import { useState } from 'react';
import { ChevronDown, Quote } from 'lucide-react';
import type { BigDealProduct } from '../engine/taskDetails';
import type { BigBriefProduct, BigTaskBrief } from '../engine/taskBrief';
import { money } from './format';
import { Section } from './TaskDrawerShared';

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/х/g, 'x').replace(/\([^)]*\)/g, ' ').replace(/[^a-zа-я0-9]+/g, ' ').trim();
const qtyStr = (q: number | null, u: string | null) => (q == null ? '—' : `${q.toLocaleString('ru-RU')} ${u ?? ''}`.trim());
const rub = (n: number | null) => (n == null ? '—' : money(n));

type Row = { name: string; kind: 'same' | 'changed' | 'removed' | 'added'; task?: BigBriefProduct; deal?: BigDealProduct };

/** Сопоставление по нормализованному названию (х/x, скобки, регистр). */
export function compareProducts(task: BigBriefProduct[], deal: BigDealProduct[]): Row[] {
  const left = [...deal];
  const rows: Row[] = [];
  for (const t of task) {
    const n = norm(t.name);
    const i = left.findIndex(d => { const m = norm(d.name); return m === n || m.startsWith(n) || n.startsWith(m); });
    if (i < 0) { rows.push({ name: t.name, kind: 'removed', task: t }); continue; }
    const d = left.splice(i, 1)[0];
    const changed = (t.qty != null && Math.abs(t.qty - d.qty) > 1e-6) || (t.price != null && Math.abs(t.price - d.price) > 0.5);
    rows.push({ name: d.name, kind: changed ? 'changed' : 'same', task: t, deal: d });
  }
  for (const d of left) rows.push({ name: d.name, kind: 'added', deal: d });
  return rows;
}

const KIND: Record<Row['kind'], { label: string; cls: string } | null> = {
  same: null,
  changed: { label: 'изменено', cls: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]' },
  removed: { label: 'нет в сделке', cls: 'bg-[var(--color-negative-soft)] text-[var(--color-negative)]' },
  added: { label: 'добавлено', cls: 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]' },
};

/** «было → стало», если отличается. */
function Diff({ a, b, fmt }: { a: number | null | undefined; b: number | null | undefined; fmt: (n: number | null) => string }) {
  if (a == null && b == null) return <>—</>;
  if (a == null) return <>{fmt(b ?? null)}</>;
  if (b == null) return <span className="text-[var(--color-text-muted)] line-through">{fmt(a)}</span>;
  if (Math.abs(a - b) < 0.5) return <>{fmt(b)}</>;
  return <><span className="text-[var(--color-text-muted)] line-through">{fmt(a)}</span> <span className="font-semibold">{fmt(b)}</span></>;
}

type View = 'compare' | 'task' | 'deal';

export function TaskBriefSection({ brief, dealProducts, dealAmount, loading, error }: {
  brief: BigTaskBrief | undefined; dealProducts: BigDealProduct[] | null | undefined; dealAmount: number | null;
  loading: boolean; error: string | null;
}) {
  const task = brief?.taskProducts ?? [];
  const deal = dealProducts ?? [];
  const rows = compareProducts(task, deal);
  const diffs = rows.filter(r => r.kind !== 'same').length;
  const hasBoth = task.length > 0 && dealProducts != null;
  // Вид по умолчанию — от данных (они приходят после первого рендера): есть отличия — «Сравнение».
  const [picked, setView] = useState<View | null>(null);
  const view: View = picked ?? (hasBoth && diffs ? 'compare' : dealProducts?.length ? 'deal' : 'task');
  const [cc, setCc] = useState(false);
  const taskTotal = brief?.taskTotal ?? null;
  const dealTotal = dealProducts?.length ? dealProducts.reduce((a, p) => a + p.sum, 0) : dealAmount;
  const delta = taskTotal != null && dealTotal != null ? dealTotal - taskTotal : null;
  const competitor = brief?.competitor ?? [];

  return (
    <Section title="Задача">
      {loading && <p className="text-[var(--color-text-muted)]">Загружаю задачу…</p>}
      {error && <p className="text-[var(--color-negative)]">{error}</p>}
      {brief && (
        <div className="flex min-w-0 flex-col gap-3">
          {brief.fields.length > 0 && (
            <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {brief.fields.map(f => (
                <div key={f.label} className={`min-w-0 ${f.label === 'Адрес' ? 'sm:col-span-2' : ''}`}>
                  <dt className="text-[11.5px] text-[var(--color-text-muted)]">{f.label}</dt>
                  <dd className={`min-w-0 break-words ${f.warn ? 'font-semibold text-[var(--color-warning)]' : ''}`}>
                    {/^https?:\/\//.test(f.value)
                      ? <a href={f.value} target="_blank" rel="noreferrer" className="break-all text-[var(--color-accent)] underline">{f.value.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}{f.value.length > 68 ? '…' : ''}</a>
                      : f.value}
                    {f.warn && <span className="ml-1 text-[11px] font-normal">· скоро</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {brief.managerComment && (
            <blockquote className="flex min-w-0 gap-2 rounded-md border-l-4 border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-2">
              <Quote size={14} className="mt-0.5 shrink-0 text-[var(--color-accent)]" aria-hidden />
              <div className="min-w-0">
                <div className="text-[11.5px] text-[var(--color-text-muted)]">Комментарий менеджера (из запроса логисту)</div>
                <div className="whitespace-pre-wrap break-words font-medium">{brief.managerComment}</div>
              </div>
            </blockquote>
          )}

          {(task.length > 0 || deal.length > 0) && (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Товары</span>
                {hasBoth && (diffs
                  ? <span className="text-[12px] text-[var(--color-warning)]">в сделке изменено позиций: {diffs}{delta ? `, ${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}` : ''}</span>
                  : <span className="text-[12px] text-[var(--color-positive)]">совпадает с задачей</span>)}
                {hasBoth && diffs > 0 && (
                  <div role="tablist" aria-label="Какие товары показать" className="ml-auto inline-flex rounded-md border border-[var(--color-border)] p-0.5 text-[12px]">
                    {([['compare', 'Сравнение'], ['task', 'Задача'], ['deal', 'Сделка']] as [View, string][]).map(([k, l]) => (
                      <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
                        className={`min-h-9 rounded px-2.5 sm:min-h-7 ${view === k ? 'bg-[var(--color-accent)] text-white' : 'hover:bg-[var(--color-bg-hover)]'}`}>{l}</button>
                    ))}
                  </div>
                )}
              </div>
              <div className="scroll-x rounded-md border border-[var(--color-border)]">
                <table className="w-full min-w-[420px] border-collapse text-[12.5px]">
                  <thead>
                    <tr className="bg-[var(--color-bg-hover)] text-left text-[11.5px] text-[var(--color-text-muted)]">
                      <th className="sticky left-0 bg-[var(--color-bg-hover)] px-2 py-1.5 font-medium">Товар</th>
                      <th className="px-2 py-1.5 text-right font-medium">Кол-во</th>
                      <th className="px-2 py-1.5 text-right font-medium">Цена</th>
                      <th className="px-2 py-1.5 text-right font-medium">Сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(view === 'compare' ? rows : view === 'task' ? task.map(t => ({ name: t.name, kind: 'same' as const, task: t })) : deal.map(d => ({ name: d.name, kind: 'same' as const, deal: d }))).map((r: Row, i) => {
                      const k = view === 'compare' ? KIND[r.kind] : null;
                      return (
                        <tr key={i} className="border-t border-[var(--color-border)] align-top">
                          <td className="sticky left-0 bg-[var(--color-bg-surface)] px-2 py-1.5">
                            <span className={r.kind === 'removed' && view === 'compare' ? 'text-[var(--color-text-muted)] line-through' : ''}>{r.name}</span>
                            {k && <span className={`ml-1.5 inline-block rounded px-1 text-[10.5px] font-medium ${k.cls}`}>{k.label}</span>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                            {view === 'compare' ? <Diff a={r.task?.qty} b={r.deal?.qty} fmt={n => qtyStr(n, r.deal?.unit ?? r.task?.unit ?? null)} /> : qtyStr(r.task?.qty ?? r.deal?.qty ?? null, r.task?.unit ?? r.deal?.unit ?? null)}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                            {view === 'compare' ? <Diff a={r.task?.price} b={r.deal?.price} fmt={rub} /> : rub(r.task?.price ?? r.deal?.price ?? null)}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                            {view === 'compare' ? <Diff a={r.task?.sum} b={r.deal?.sum} fmt={rub} /> : rub(r.task?.sum ?? r.deal?.sum ?? null)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {(taskTotal != null || dealTotal != null) && (
                <p className="text-[12.5px] tabular-nums">
                  {taskTotal != null && <>При постановке <b>{money(taskTotal)}</b></>}
                  {taskTotal != null && dealTotal != null && ' → '}
                  {dealTotal != null && <>в сделке <b>{money(dealTotal)}</b></>}
                  {delta ? <span className={delta > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}> ({delta > 0 ? '+' : '−'}{money(Math.abs(delta))}, {delta > 0 ? '+' : '−'}{Math.abs(Math.round((delta / (taskTotal || 1)) * 100))}%)</span> : null}
                </p>
              )}
            </div>
          )}

          {competitor.length > 0 && (
            <div className="flex min-w-0 flex-col gap-1 rounded-md border border-[var(--color-border)] px-3 py-2">
              <span className="text-[11.5px] text-[var(--color-text-muted)]">Цена конкурента (из запроса)</span>
              {competitor.map((c, i) => {
                const ours = task.find(t => norm(t.name) === norm(c.name))?.price ?? null;
                const pct = ours ? Math.round(((c.price - ours) / ours) * 100) : null;
                return (
                  <div key={i} className="flex min-w-0 flex-wrap gap-x-2">
                    <span className="min-w-0 break-words">{c.name}</span>
                    <b className="tabular-nums">{money(c.price)}</b>
                    {ours != null && pct != null && <span className={pct < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}>наша {money(ours)}, конкурент {pct > 0 ? '+' : ''}{pct}%</span>}
                  </div>
                );
              })}
            </div>
          )}

          {brief.callCenter && (
            <div className="min-w-0">
              <button type="button" onClick={() => setCc(!cc)} aria-expanded={cc}
                className="inline-flex min-h-11 items-center gap-1 text-[12.5px] text-[var(--color-accent)] sm:min-h-8">
                <ChevronDown size={13} className={`transition-transform ${cc ? 'rotate-180' : ''}`} aria-hidden /> Заявка из колл-центра
              </button>
              {cc && <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg-hover)] px-3 py-2 font-sans text-[12.5px]">{brief.callCenter}</pre>}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
