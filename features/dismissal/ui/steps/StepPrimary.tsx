'use client';

import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { PRIMARY_MIN_AMOUNT, type DismissalItem, type DismissalOverride } from '../../types';
import { actionAllowed, defaultAction, fmtMln, fmtNum, plural, ruleOf } from '../planMath';
import { EmptySearch, KeyHint, MoreButton, SearchBox, useListKeys, useRowSelection } from '../ItemRow';
import { BulkBar } from '../BulkBar';
import { PanelCard, RecipientTiles, RuleControl, type Tile } from '../RecipientPanel';
import { EmptyStep, StepLayout, WizardFooter } from '../StepLayout';
import { card } from '../shared';
import type { WizardCtx } from '../wizardCtx';
import { DEAL_GRID_Q, DealHeader, DealRow, ReasonBadge } from './DealRow';

// Шаг 3 «Сладкая первичка»: бронь и дальше или чек ≥ порога — раздаём людям или отделу, по кругу.

const PAGE = 50;
const PANEL = 'w-[400px] max-w-[calc(100vw-16px)]';

/** Исключение первички: действие (если не умолчание) и/или ручной получатель. */
export function setPrimary(ctx: WizardCtx, items: DismissalItem[], patch: { action?: 'transfer' | 'brak' | 'skip'; target?: number | null } | null) {
  const out: Record<string, DismissalOverride | null> = {};
  for (const it of items) {
    if (!patch) { out[it.key] = null; continue; }
    const cur = ctx.plan.overrides[it.key];
    const action = patch.action ?? cur?.action ?? defaultAction(it);
    if (action === 'brak' && !actionAllowed(it, 'brak')) continue;
    const target = action === 'transfer' ? (patch.target !== undefined ? patch.target : cur?.target ?? null) : null;
    out[it.key] = action === defaultAction(it) && !target ? null : { action, target };
  }
  ctx.setOverrides(out);
}

/** Плитки получателей первички по строкам. */
export function primaryTiles(ctx: WizardCtx, items: DismissalItem[]): Tile[] {
  const rule = ruleOf(ctx.plan, 'deal_primary');
  const m = new Map<number, Tile>();
  for (const id of rule.departmentId ? [] : rule.targets) m.set(id, { id, deals: 0, value: 0 });
  for (const it of items) {
    const r = ctx.resolved.get(it.key);
    if (r?.action !== 'transfer' || r.target == null) continue;
    const e = m.get(r.target) ?? { id: r.target, deals: 0, value: 0 };
    e.deals++; e.value += it.info?.amount ?? 0;
    m.set(r.target, e);
  }
  return [...m.values()].sort((a, b) => b.deals - a.deals);
}

/** Ячейка получателя сделки первички. */
export function PrimaryRecipient({ ctx, it }: { ctx: WizardCtx; it: DismissalItem }) {
  const r = ctx.resolved.get(it.key);
  const manual = ctx.plan.overrides[it.key]?.target ?? null;
  if (r?.action === 'brak' || r?.action === 'skip') {
    return (
      <span className="flex items-center gap-2 text-sm">
        <span className={r.action === 'brak' ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'}>{r.action === 'brak' ? 'в брак' : 'не трогаем'}</span>
        <button type="button" onClick={() => setPrimary(ctx, [it], { action: 'transfer' })} className="tap-target text-[var(--color-accent)] hover:underline">
          {it.info?.qualified ? 'Вернуть' : 'Спасти'}
        </button>
      </span>
    );
  }
  const auto = r?.target != null && !manual ? ctx.nameOf(r.target) : null;
  return (
    <div data-recipient className="flex items-center gap-1">
      <SearchSelect options={ctx.recipients} value={manual ? String(manual) : ''} onChange={v => v && setPrimary(ctx, [it], { action: 'transfer', target: Number(v) })}
        searchable placeholder={auto ? `${auto} · по кругу` : 'Кому?'} searchPlaceholder="Имя, должность, отдел…" ariaLabel={`Кому «${it.title}»`}
        className={`w-full ${!auto && !manual ? 'border-[var(--color-negative)]' : ''} ${auto ? '[&>span]:text-[var(--color-text-muted)]' : ''}`} panelClassName={PANEL} />
      {manual && (
        <button type="button" onClick={() => setPrimary(ctx, [it], { target: null })} aria-label="Вернуть к правилу" title="К правилу"
          className="tap-target shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><RotateCcw size={13} /></button>
      )}
    </div>
  );
}

export function StepPrimary({ ctx }: { ctx: WizardCtx }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? ctx.primaryQ.filter(it => `${it.title} ${it.info?.stageName ?? ''} ${it.entityId}`.toLowerCase().includes(needle)) : ctx.primaryQ;
  }, [ctx.primaryQ, q]);
  const visible = rows.slice(0, limit);
  const keys = visible.map(i => i.key);
  const sel = useRowSelection(keys);
  const byKey = useMemo(() => new Map(ctx.primaryQ.map(i => [i.key, i])), [ctx.primaryQ]);
  const pick = (ks: string[]) => ks.map(k => byKey.get(k)).filter(Boolean) as DismissalItem[];
  const tiles = useMemo(() => primaryTiles(ctx, ctx.primaryQ), [ctx]);
  const free = ctx.primaryQ.filter(it => ctx.resolved.get(it.key)?.action === 'transfer' && !ctx.plan.overrides[it.key]?.target).length;
  const onKeyDown = useListKeys(keys, sel, {
    onAssign: (n, ks) => { const t = tiles[n]; if (t) setPrimary(ctx, pick(ks), { action: 'transfer', target: t.id }); },
    onBrak: ks => setPrimary(ctx, pick(ks), { action: 'brak' }),
    onReset: ks => setPrimary(ctx, pick(ks), null),
  });
  const selSum = pick([...sel.selected]).reduce((s, i) => s + (i.info?.amount ?? 0), 0);
  const selBrakable = pick([...sel.selected]).some(i => actionAllowed(i, 'brak'));

  const panel = (
    <PanelCard title="Кому раздаём">
      <RuleControl ctx={ctx} kind="deal_primary" freeCount={free} unit={['сделка', 'сделки', 'сделок']} />
      <RecipientTiles ctx={ctx} tiles={tiles} valueLabel="сумма" canAssign={sel.selected.size > 0}
        onAssign={id => { setPrimary(ctx, pick([...sel.selected]), { action: 'transfer', target: id }); sel.clear(); }} />
    </PanelCard>
  );

  return (
    <StepLayout title="3. Сладкая первичка" subtitle={`Бронь и дальше или чек от ${fmtNum(PRIMARY_MIN_AMOUNT)} ₽. Раздаём людям или отделу, по кругу.`}
      panel={ctx.primaryQ.length ? panel : undefined}
      panelSummary={`${fmtNum(ctx.primaryQ.filter(it => ctx.resolved.get(it.key)?.action === 'transfer').length)} к передаче · ${tiles.length} ${plural(tiles.length, ['получатель', 'получателя', 'получателей'])}`}
      footer={plaque => (
        <WizardFooter ctx={ctx} plaque={plaque} bulk={sel.selected.size > 0 ? (
          <BulkBar count={sel.selected.size} extra={fmtMln(selSum)} recipients={ctx.recipients}
            onTransfer={id => { setPrimary(ctx, pick([...sel.selected]), { action: 'transfer', target: id }); sel.clear(); }}
            onBrak={selBrakable ? () => { setPrimary(ctx, pick([...sel.selected]), { action: 'brak' }); sel.clear(); } : undefined}
            onReset={() => { setPrimary(ctx, pick([...sel.selected]), null); sel.clear(); }} onClear={sel.clear} />
        ) : undefined} />
      )}>
      {ctx.primaryQ.length === 0 ? (
        <EmptyStep ctx={ctx} text="Первичных сделок с бронью или крупным чеком нет — шаг можно пропустить." />
      ) : (
        <>
          <div className="mb-3"><SearchBox value={q} onChange={v => { setQ(v); setLimit(PAGE); }} placeholder="Сделка, стадия или №" /></div>
          <div className={card} tabIndex={0} onKeyDown={onKeyDown} aria-label="Сладкая первичка" role="group">
            <DealHeader grid={DEAL_GRID_Q} cols={['Сделка и стадия', 'Сумма', 'Почему', 'Кому']} />
            <ul className="divide-y divide-[var(--color-border)]">
              {visible.map(it => (
                <DealRow key={it.key} item={it} grid={DEAL_GRID_Q} focused={sel.focus === it.key} selected={sel.selected.has(it.key)}
                  onToggle={sh => sel.toggle(it.key, sh)} onFocus={() => sel.setFocus(it.key)}
                  badge={<ReasonBadge reason={it.info?.qualifyReason} />} last={<PrimaryRecipient ctx={ctx} it={it} />} />
              ))}
            </ul>
            {rows.length === 0 && <EmptySearch onReset={() => setQ('')} />}
            <MoreButton left={rows.length - limit} onClick={() => setLimit(l => l + PAGE)} />
            <KeyHint brak="в брак" />
          </div>
        </>
      )}
    </StepLayout>
  );
}
