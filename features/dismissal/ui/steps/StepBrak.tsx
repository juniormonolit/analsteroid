'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { PRIMARY_MIN_AMOUNT, type DismissalItem } from '../../types';
import { actionAllowed, fmtMln, fmtNum, fmtRub } from '../planMath';
import { EmptySearch, KeyHint, SearchBox, useListKeys, useRowSelection } from '../ItemRow';
import { BulkBar } from '../BulkBar';
import { PanelCard, RecipientTiles, RuleControl } from '../RecipientPanel';
import { EmptyStep, StepLayout, WizardFooter } from '../StepLayout';
import { btnSecondary, card } from '../shared';
import type { WizardCtx } from '../wizardCtx';
import { DEAL_GRID_N, DealHeader, DealRow } from './DealRow';
import { PrimaryRecipient, primaryTiles, setPrimary } from './StepPrimary';

// Шаг 4 «Оставшаяся первичка»: не дошли до брони и чек меньше порога — по умолчанию в автобрак,
// нужную сделку можно спасти. В воронках без автобрака — передаём.

type G = 'brak' | 'saved' | 'nobrak' | 'skip';
const PAGE = 50;

export function StepBrak({ ctx }: { ctx: WizardCtx }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<G, boolean>>({ brak: true, saved: true, nobrak: true, skip: false });
  const [limits, setLimits] = useState<Record<G, number>>({ brak: PAGE, saved: PAGE, nobrak: PAGE, skip: PAGE });
  const groupOf = (it: DismissalItem): G => {
    const a = ctx.resolved.get(it.key)?.action;
    if (a === 'brak') return 'brak';
    if (a === 'skip') return 'skip';
    return it.info?.brakAvailable ? 'saved' : 'nobrak';
  };
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? ctx.primaryN.filter(it => `${it.title} ${it.info?.stageName ?? ''} ${it.entityId}`.toLowerCase().includes(needle)) : ctx.primaryN;
  }, [ctx.primaryN, q]);
  const groups = useMemo(() => {
    const g: Record<G, DismissalItem[]> = { brak: [], saved: [], nobrak: [], skip: [] };
    for (const it of filtered) g[groupOf(it)].push(it);
    return g;
  }, [filtered, ctx.resolved]); // eslint-disable-line react-hooks/exhaustive-deps
  const order: G[] = ['brak', 'saved', 'nobrak', 'skip'];
  const keys = order.flatMap(g => open[g] ? groups[g].slice(0, limits[g]).map(i => i.key) : []);
  const sel = useRowSelection(keys);
  const byKey = useMemo(() => new Map(ctx.primaryN.map(i => [i.key, i])), [ctx.primaryN]);
  const pick = (ks: string[]) => ks.map(k => byKey.get(k)).filter(Boolean) as DismissalItem[];
  const tiles = useMemo(() => primaryTiles(ctx, ctx.primaryN), [ctx]);
  const onKeyDown = useListKeys(keys, sel, {
    onAssign: (n, ks) => { const t = tiles[n]; if (t) setPrimary(ctx, pick(ks), { action: 'transfer', target: t.id }); },
    onBrak: ks => setPrimary(ctx, pick(ks), { action: 'brak' }),
    onReset: ks => setPrimary(ctx, pick(ks), null),
  });

  const all = { brak: 0, brakSum: 0, saved: 0, nobrak: 0 };
  for (const it of ctx.primaryN) {
    const g = groupOf(it);
    if (g === 'brak') { all.brak++; all.brakSum += it.info?.amount ?? 0; }
    if (g === 'saved') all.saved++;
    if (g === 'nobrak') all.nobrak++;
  }
  const toTransfer = ctx.primaryN.filter(it => ctx.resolved.get(it.key)?.action === 'transfer');
  const free = toTransfer.filter(it => !ctx.plan.overrides[it.key]?.target).length;
  const selItems = pick([...sel.selected]);

  const panel = (
    <PanelCard title="Итог шага">
      <div className="flex flex-col gap-0.5 text-sm tabular-nums">
        <span className="text-[var(--color-warning)]">В брак <b>{fmtNum(all.brak)}</b> · {fmtRub(all.brakSum)}</span>
        <span>Спасаем <b>{fmtNum(all.saved)}</b>{all.nobrak > 0 && <> · без автобрака передаём <b>{fmtNum(all.nobrak)}</b></>}</span>
      </div>
      {toTransfer.length > 0 && (
        <>
          <div className="border-t border-[var(--color-border)] pt-2">
            <h4 className="text-sm font-medium text-[var(--color-text)]">Кому уйдут спасённые</h4>
            <p className="mb-2 text-xs text-[var(--color-text-muted)]">Общее с шагом 3.</p>
            <RuleControl ctx={ctx} kind="deal_primary" freeCount={free} unit={['сделка', 'сделки', 'сделок']} />
          </div>
          <RecipientTiles ctx={ctx} tiles={tiles} valueLabel="сумма" canAssign={sel.selected.size > 0}
            onAssign={id => { setPrimary(ctx, selItems, { action: 'transfer', target: id }); sel.clear(); }} />
        </>
      )}
    </PanelCard>
  );

  const TITLES: Record<G, React.ReactNode> = {
    brak: <>В автобрак · {fmtNum(groups.brak.length)}{groups.brak.length > 0 && <> · {fmtRub(groups.brak.reduce((s, i) => s + (i.info?.amount ?? 0), 0))}</>}</>,
    saved: <>Спасённые · {fmtNum(groups.saved.length)}</>,
    nobrak: <>Автобрака в воронке нет — передаём · {fmtNum(groups.nobrak.length)}</>,
    skip: <>Не трогаем · {fmtNum(groups.skip.length)}</>,
  };

  const lastCell = (it: DismissalItem, g: G) => {
    if (g === 'brak') return <button type="button" onClick={() => setPrimary(ctx, [it], { action: 'transfer' })} className={`${btnSecondary} min-h-9`}>Спасти</button>;
    if (g === 'saved') return (
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><PrimaryRecipient ctx={ctx} it={it} /></div>
        <button type="button" onClick={() => setPrimary(ctx, [it], null)} className="tap-target shrink-0 text-xs text-[var(--color-warning)] hover:underline">Вернуть в брак</button>
      </div>
    );
    if (g === 'nobrak') return <PrimaryRecipient ctx={ctx} it={it} />;
    return <button type="button" onClick={() => setPrimary(ctx, [it], null)} className="tap-target text-sm text-[var(--color-accent)] hover:underline">Вернуть</button>;
  };

  return (
    <StepLayout title="4. Оставшаяся первичка"
      subtitle={`Не дошли до брони и чек меньше ${fmtNum(PRIMARY_MIN_AMOUNT)} ₽. По умолчанию — в автобрак: сделка уходит в стадию «НЕ ТРОГАТЬ», остаётся на уволенном, задачи по ней закрываются. Нужную сделку можно спасти.`}
      panel={ctx.primaryN.length ? panel : undefined}
      panelSummary={`В брак ${all.brak} · спасаем ${all.saved}${all.nobrak ? ` · передаём ${all.nobrak}` : ''}`}
      footer={plaque => (
        <WizardFooter ctx={ctx} plaque={plaque} bulk={sel.selected.size > 0 ? (
          <BulkBar count={sel.selected.size} extra={fmtMln(selItems.reduce((s, i) => s + (i.info?.amount ?? 0), 0))} recipients={ctx.recipients}
            onTransfer={id => { setPrimary(ctx, selItems, { action: 'transfer', target: id }); sel.clear(); }}
            onBrak={selItems.some(i => actionAllowed(i, 'brak')) ? () => { setPrimary(ctx, selItems, { action: 'brak' }); sel.clear(); } : undefined}
            onReset={() => { setPrimary(ctx, selItems, null); sel.clear(); }} onClear={sel.clear}>
            <button type="button" className={btnSecondary} onClick={() => { setPrimary(ctx, selItems, { action: 'transfer' }); sel.clear(); }}>Спасти</button>
          </BulkBar>
        ) : undefined} />
      )}>
      {ctx.primaryN.length === 0 ? (
        <EmptyStep ctx={ctx} text="Оставшейся первички нет — шаг можно пропустить." />
      ) : (
        <>
          <div className="mb-3"><SearchBox value={q} onChange={setQ} placeholder="Сделка, стадия или №" /></div>
          <div className={card} tabIndex={0} onKeyDown={onKeyDown} aria-label="Оставшаяся первичка" role="group">
            <DealHeader grid={DEAL_GRID_N} cols={['Сделка', 'Стадия', 'Сумма', 'Что делаем']} />
            {order.map((g, gi) => groups[g].length === 0 ? null : (
              <div key={g} className={gi ? 'border-t border-[var(--color-border)]' : ''}>
                <button type="button" onClick={() => setOpen(o => ({ ...o, [g]: !o[g] }))} aria-expanded={open[g]}
                  className={`flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-medium hover:bg-[var(--color-bg-hover)] ${g === 'brak' ? 'text-[var(--color-warning)]' : 'text-[var(--color-text)]'}`}>
                  {open[g] ? <ChevronDown size={16} className="shrink-0" /> : <ChevronRight size={16} className="shrink-0" />}
                  <span className="min-w-0 flex-1">{TITLES[g]}</span>
                </button>
                {g === 'nobrak' && open[g] && (
                  <p className="px-3 pb-2 text-xs text-[var(--color-text-muted)]">В воронках «Холодные» и «Тендеры» стадии автобрака нет — такие сделки по умолчанию передаём.</p>
                )}
                {open[g] && (
                  <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                    {groups[g].slice(0, limits[g]).map(it => (
                      <DealRow key={it.key} item={it} grid={DEAL_GRID_N} focused={sel.focus === it.key} selected={sel.selected.has(it.key)}
                        onToggle={sh => sel.toggle(it.key, sh)} onFocus={() => sel.setFocus(it.key)} last={lastCell(it, g)} />
                    ))}
                  </ul>
                )}
                {open[g] && groups[g].length > limits[g] && (
                  <button type="button" onClick={() => setLimits(l => ({ ...l, [g]: l[g] + PAGE }))}
                    className="flex min-h-11 w-full items-center justify-center border-t border-[var(--color-border)] text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                    Показать ещё (осталось {fmtNum(groups[g].length - limits[g])})
                  </button>
                )}
              </div>
            ))}
            {filtered.length === 0 && <EmptySearch onReset={() => setQ('')} />}
            <KeyHint brak="в брак" />
          </div>
        </>
      )}
    </StepLayout>
  );
}

