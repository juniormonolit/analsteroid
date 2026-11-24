'use client';

import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { REPEAT_BRAK_REASONS } from '../../types';
import { fmtMln, fmtNum, plural, ruleOf, type RepeatClient } from '../planMath';
import { EmptySearch, KeyHint, MoreButton, SearchBox, useListKeys, useRowSelection } from '../ItemRow';
import { BulkBar } from '../BulkBar';
import { PanelCard, RecipientTiles, RuleControl, type Tile } from '../RecipientPanel';
import { EmptyStep, StepLayout, WizardFooter } from '../StepLayout';
import { btnSecondary, card } from '../shared';
import type { WizardCtx } from '../wizardCtx';
import { ClientHeader, ClientRow } from './ClientRow';
import { setClients } from './StepTop';

// Шаг 2 «Остальная повторка»: раздать поровну (людям / отделу, змейкой по рангу) или закрыть; можно частично.

const PAGE = 50;

export function StepRest({ ctx }: { ctx: WizardCtx }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const rule = ruleOf(ctx.plan, 'deal_repeat');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? ctx.rest.filter(c => `${c.name} ${c.items.map(i => i.title).join(' ')}`.toLowerCase().includes(needle)) : ctx.rest;
  }, [ctx.rest, q]);
  const visible = rows.slice(0, limit);
  const keys = visible.map(c => c.key);
  const sel = useRowSelection(keys);
  const byKey = useMemo(() => new Map(ctx.rest.map(c => [c.key, c])), [ctx.rest]);
  const pick = (ks: string[]) => ks.map(k => byKey.get(k)).filter(Boolean) as RepeatClient[];

  const restItems = useMemo(() => ctx.rest.flatMap(c => c.items), [ctx.rest]);
  const tiles: Tile[] = useMemo(() => {
    const m = new Map<number, Tile & { seen: Set<string> }>();
    for (const id of rule.departmentId ? [] : rule.targets) m.set(id, { id, deals: 0, clients: 0, value: 0, seen: new Set() });
    for (const it of restItems) {
      const r = ctx.resolved.get(it.key);
      if (r?.action !== 'transfer' || r.target == null) continue;
      const e = m.get(r.target) ?? { id: r.target, deals: 0, clients: 0, value: 0, seen: new Set<string>() };
      e.deals++;
      const ck = it.info?.clientKey ?? it.key;
      if (!e.seen.has(ck)) { e.seen.add(ck); e.clients = (e.clients ?? 0) + 1; e.value += it.info?.ltv ?? 0; }
      m.set(r.target, e);
    }
    return [...m.values()].map(({ seen: _s, ...t }) => t).sort((a, b) => b.value - a.value);
  }, [restItems, ctx.resolved, rule.departmentId, rule.targets]);
  const closing = restItems.filter(it => ctx.resolved.get(it.key)?.action === 'brak').length;
  const freeClients = ctx.rest.filter(c => c.items.every(it => !ctx.plan.overrides[it.key])).length;

  const transfer = (id: number, cs: RepeatClient[]) => setClients(ctx, cs, { action: 'transfer', target: id });
  const onKeyDown = useListKeys(keys, sel, {
    onAssign: (n, ks) => { const t = tiles[n]; if (t) transfer(t.id, pick(ks)); },
    onBrak: ks => setClients(ctx, pick(ks), { action: 'brak' }),
    onReset: ks => setClients(ctx, pick(ks), null),
  });
  const selLtv = pick([...sel.selected]).reduce((s, c) => s + c.ltv, 0);
  const reason = REPEAT_BRAK_REASONS.find(r => r.value === (ctx.plan.repeatBrakReason ?? 'nothing_needed'))?.label;

  const panel = (
    <PanelCard title="Что делаем с остальными">
      <RuleControl ctx={ctx} kind="deal_repeat" freeCount={freeClients} unit={['заказчик', 'заказчика', 'заказчиков']} allowClose
        hint="Змейкой по рангу — LTV делится ровно" />
      <RecipientTiles ctx={ctx} tiles={tiles} valueLabel="LTV" canAssign={sel.selected.size > 0}
        onAssign={id => { transfer(id, pick([...sel.selected])); sel.clear(); }} />
      {closing > 0 && (
        <p className="text-sm text-[var(--color-warning)]">Закрываем: <b>{fmtNum(closing)}</b> {plural(closing, ['сделка', 'сделки', 'сделок'])}{reason && <span className="text-[var(--color-text-muted)]"> · {reason}</span>}</p>
      )}
    </PanelCard>
  );

  const quick = (f: (c: RepeatClient) => boolean) => sel.selectMany(visible.filter(f).map(c => c.key));

  return (
    <StepLayout title="2. Остальная повторка" subtitle="Остальных раздаём поровну — людям или отделу — либо закрываем. Можно частично."
      panel={ctx.rest.length ? panel : undefined}
      panelSummary={rule.action === 'brak' ? `Закрываем ${closing} · ${tiles.length} получ.` : `${tiles.length} ${plural(tiles.length, ['получатель', 'получателя', 'получателей'])}${closing ? ` · закрываем ${closing}` : ''}`}
      footer={plaque => (
        <WizardFooter ctx={ctx} plaque={plaque} bulk={sel.selected.size > 0 ? (
          <BulkBar count={sel.selected.size} extra={`LTV ${fmtMln(selLtv)}`} recipients={ctx.recipients}
            onTransfer={id => { transfer(id, pick([...sel.selected])); sel.clear(); }}
            onBrak={() => { setClients(ctx, pick([...sel.selected]), { action: 'brak' }); sel.clear(); }} brakLabel="Закрыть"
            onReset={() => { setClients(ctx, pick([...sel.selected]), null); sel.clear(); }} onClear={sel.clear} />
        ) : undefined} />
      )}>
      {ctx.rest.length === 0 ? (
        <EmptyStep ctx={ctx} text={ctx.clients.length ? 'Все повторные заказчики — в топе. Шаг можно пропустить.' : 'Повторных сделок нет — шаг можно пропустить.'} />
      ) : (
        <>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <SearchBox value={q} onChange={v => { setQ(v); setLimit(PAGE); }} placeholder="Заказчик или сделка" />
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-[var(--color-text-muted)]">Выделить:</span>
              <button type="button" className={btnSecondary} onClick={() => quick(c => !c.ltv)}>с LTV 0</button>
              <button type="button" className={btnSecondary} onClick={() => quick(c => !c.shipments)}>без отгрузок</button>
              <button type="button" className={btnSecondary} onClick={() => quick(() => true)}>все</button>
            </div>
          </div>
          <div className={card} tabIndex={0} onKeyDown={onKeyDown} aria-label="Остальные заказчики" role="group">
            <ClientHeader last="Исход" />
            <ul className="divide-y divide-[var(--color-border)]">
              {visible.map(c => {
                const r = ctx.resolved.get(c.items[0].key);
                const manual = c.items.some(it => ctx.plan.overrides[it.key]);
                const text = r?.action === 'brak' ? 'закрыть' : r?.action === 'skip' ? 'не трогать' : r?.target != null ? `→ ${ctx.nameOf(r.target)}` : '→ не выбрано';
                return (
                  <ClientRow key={c.key} client={c} focused={sel.focus === c.key} selected={sel.selected.has(c.key)}
                    onToggle={sh => sel.toggle(c.key, sh)} onFocus={() => sel.setFocus(c.key)}
                    last={
                      <span className="flex min-w-0 items-center gap-1.5 text-sm">
                        {manual && <span aria-label="вручную" title="вручную" className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" />}
                        <span className={`min-w-0 truncate ${r?.action === 'brak' ? 'text-[var(--color-warning)]' : r?.action === 'transfer' && r.target == null ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>{text}</span>
                        {manual && (
                          <button type="button" onClick={() => setClients(ctx, [c], null)} aria-label="Вернуть к правилу" title="К правилу"
                            className="tap-target shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><RotateCcw size={13} /></button>
                        )}
                      </span>
                    } />
                );
              })}
            </ul>
            {rows.length === 0 && <EmptySearch onReset={() => setQ('')} />}
            <MoreButton left={rows.length - limit} onClick={() => setLimit(l => l + PAGE)} />
            <KeyHint brak="закрыть" />
          </div>
        </>
      )}
    </StepLayout>
  );
}
