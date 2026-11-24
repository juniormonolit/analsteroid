'use client';

import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { DismissalOverride } from '../../types';
import { fmtMln, fmtNum, plural, ruleOf, topCountOf, type RepeatClient } from '../planMath';
import { Chips, EmptySearch, KeyHint, SearchBox, useListKeys, useRowSelection } from '../ItemRow';
import { BulkBar } from '../BulkBar';
import { PanelCard, RecipientTiles, type Tile } from '../RecipientPanel';
import { EmptyStep, StepLayout, WizardFooter } from '../StepLayout';
import { card } from '../shared';
import type { WizardCtx } from '../wizardCtx';
import { ClientHeader, ClientRow } from './ClientRow';

// Шаг 1 «Сладкая повторка»: лучшие заказчики по LTV — каждому получатель вручную.

const PANEL = 'w-[400px] max-w-[calc(100vw-16px)]';

/** Ручной получатель заказчика: один на все сделки / «разные» / нет. */
export function manualOf(ctx: WizardCtx, c: RepeatClient): { target: number | null; mixed: boolean; brak: boolean } {
  const ovs = c.items.map(it => ctx.plan.overrides[it.key]);
  const ts = ovs.map(o => o?.target ?? null);
  const mixed = ts.some(t => t !== ts[0]);
  return { target: mixed ? null : ts[0], mixed, brak: ovs.every(o => o?.action === 'brak') };
}

export function setClients(ctx: WizardCtx, clients: RepeatClient[], ov: DismissalOverride | null) {
  const patch: Record<string, DismissalOverride | null> = {};
  for (const c of clients) for (const it of c.items) patch[it.key] = ov;
  ctx.setOverrides(patch);
}

export function StepTop({ ctx }: { ctx: WizardCtx }) {
  const topN = topCountOf(ctx.plan);
  const [topStr, setTopStr] = useState(String(topN));
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'none'>('all');
  const repRule = ruleOf(ctx.plan, 'deal_repeat');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ctx.top.filter(c =>
      (filter === 'all' || (!manualOf(ctx, c).target && !manualOf(ctx, c).mixed)) &&
      (!needle || `${c.name} ${c.items.map(i => i.title).join(' ')}`.toLowerCase().includes(needle)));
  }, [ctx, q, filter]);
  const keys = rows.map(c => c.key);
  const sel = useRowSelection(keys);
  const byKey = useMemo(() => new Map(ctx.top.map(c => [c.key, c])), [ctx.top]);
  const pick = (ks: string[]) => ks.map(k => byKey.get(k)).filter(Boolean) as RepeatClient[];

  // Кандидаты-получатели: локально; старт — ручные получатели топа ∪ получатели правила.
  const [candidates, setCandidates] = useState<number[]>(() => [...new Set([
    ...ctx.top.flatMap(c => c.items.map(it => ctx.plan.overrides[it.key]?.target ?? 0)).filter(Boolean),
    ...repRule.targets,
  ])]);
  const tiles: Tile[] = useMemo(() => {
    const m = new Map<number, Tile>();
    for (const id of candidates) m.set(id, { id, deals: 0, clients: 0, value: 0 });
    for (const c of ctx.top) {
      const t = manualOf(ctx, c).target;
      if (!t) continue;
      const e = m.get(t) ?? { id: t, deals: 0, clients: 0, value: 0 };
      e.deals += c.items.length; e.clients = (e.clients ?? 0) + 1; e.value += c.ltv;
      m.set(t, e);
    }
    return [...m.values()];
  }, [candidates, ctx]);

  const assign = (id: number, clients: RepeatClient[]) => {
    if (!clients.length) return;
    setClients(ctx, clients, { action: 'transfer', target: id });
    if (!candidates.includes(id)) setCandidates(cs => [...cs, id]);
  };
  const onKeyDown = useListKeys(keys, sel, {
    onAssign: (n, ks) => { const t = tiles[n]; if (t) assign(t.id, pick(ks)); },
    onBrak: ks => setClients(ctx, pick(ks), { action: 'brak' }),
    onReset: ks => setClients(ctx, pick(ks), null),
  });

  const applyTop = () => {
    const raw = topStr.trim();
    const n = Math.round(Number(raw));
    if (raw === '' || !Number.isFinite(n) || n < 0) { setTopStr(String(topN)); return; }
    const v = Math.min(500, n);
    ctx.setTopCount(v); setTopStr(String(v));
  };

  const distributed = ctx.top.filter(c => manualOf(ctx, c).target).length;
  const ltvAll = ctx.top.reduce((s, c) => s + c.ltv, 0);
  const ltvDist = ctx.top.filter(c => manualOf(ctx, c).target).reduce((s, c) => s + c.ltv, 0);
  const selLtv = pick([...sel.selected]).reduce((s, c) => s + c.ltv, 0);

  const panel = (
    <PanelCard title="Кто получает">
      <SearchMultiSelect options={ctx.recipients} value={candidates.map(String)} onChange={v => setCandidates(v.map(Number))}
        allLabel={ctx.usersReady ? 'Добавьте получателей' : 'Загружаю сотрудников…'} unitLabel={plural(candidates.length, ['получатель', 'получателя', 'получателей'])}
        searchPlaceholder="Имя, должность, отдел…" ariaLabel="Кто получает топ" className="w-full" panelClassName={PANEL} />
      <RecipientTiles ctx={ctx} tiles={tiles} valueLabel="LTV" canAssign={sel.selected.size > 0}
        onAssign={id => { assign(id, pick([...sel.selected])); sel.clear(); }} />
      <div className="border-t border-[var(--color-border)] pt-2 text-xs tabular-nums text-[var(--color-text-muted)]">
        Распределено <b className="text-[var(--color-text)]">{distributed}</b> из {ctx.top.length} · LTV {fmtMln(ltvDist)} из {fmtMln(ltvAll)}
        {distributed > 0 && <> · <button type="button" onClick={() => setClients(ctx, ctx.top, null)} className="tap-target text-[var(--color-accent)] hover:underline">Сбросить выбор</button></>}
      </div>
    </PanelCard>
  );

  return (
    <StepLayout title="1. Сладкая повторка" subtitle="Лучшие заказчики по LTV и отгрузкам. Каждому выберите получателя вручную."
      panel={ctx.top.length ? panel : undefined}
      panelSummary={`Распределено ${distributed} из ${ctx.top.length} · ${tiles.length} ${plural(tiles.length, ['человек', 'человека', 'человек'])}`}
      footer={plaque => (
        <WizardFooter ctx={ctx} plaque={plaque} bulk={sel.selected.size > 0 ? (
          <BulkBar count={sel.selected.size} extra={`LTV ${fmtMln(selLtv)}`} recipients={ctx.recipients}
            onTransfer={id => { assign(id, pick([...sel.selected])); sel.clear(); }}
            onBrak={() => { setClients(ctx, pick([...sel.selected]), { action: 'brak' }); sel.clear(); }} brakLabel="Закрыть"
            onReset={() => { setClients(ctx, pick([...sel.selected]), null); sel.clear(); }} onClear={sel.clear} />
        ) : undefined} />
      )}>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          Топ
          <input value={topStr} onChange={e => setTopStr(e.target.value)} onBlur={applyTop} onKeyDown={e => { if (e.key === 'Enter') applyTop(); }}
            inputMode="numeric" aria-label="Сколько заказчиков в топе"
            className="min-h-11 w-16 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 text-center text-base tabular-nums text-[var(--color-text)] outline-none sm:text-sm" />
          {ctx.clients.length > 0 && <span className="text-xs">из {fmtNum(ctx.clients.length)}</span>}
        </label>
        <SearchBox value={q} onChange={setQ} placeholder="Заказчик или сделка" />
        <Chips value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Все' }, { value: 'none', label: `Без получателя · ${ctx.top.length - distributed}` }]} />
      </div>
      {ctx.clients.length === 0 ? (
        <EmptyStep ctx={ctx} text="Повторных сделок нет — шаг можно пропустить." />
      ) : ctx.top.length === 0 ? (
        <EmptyStep ctx={ctx} text="Топ выключен (0 заказчиков) — все повторные уходят по правилу шага 2." />
      ) : (
        <div className={card} tabIndex={0} onKeyDown={onKeyDown} aria-label="Топ заказчиков" role="group">
          <ClientHeader last="Кому" />
          <ul className="divide-y divide-[var(--color-border)]">
            {rows.map(c => {
              const m = manualOf(ctx, c);
              const auto = ctx.resolved.get(c.items[0].key);
              return (
                <ClientRow key={c.key} client={c} focused={sel.focus === c.key} selected={sel.selected.has(c.key)}
                  onToggle={sh => sel.toggle(c.key, sh)} onFocus={() => sel.setFocus(c.key)}
                  last={m.brak ? (
                    <span className="flex items-center gap-2 text-sm text-[var(--color-warning)]">закроется
                      <button type="button" onClick={() => setClients(ctx, [c], null)} className="tap-target text-[var(--color-accent)] hover:underline">Вернуть</button>
                    </span>
                  ) : (
                    <div data-recipient className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1">
                        <SearchSelect options={ctx.recipients} value={m.mixed ? '__mixed' : m.target ? String(m.target) : ''} onChange={v => v && assign(Number(v), [c])}
                          searchable placeholder={m.mixed ? 'Разным получателям' : 'Кому?'} searchPlaceholder="Имя, должность, отдел…" ariaLabel={`Кому заказчика «${c.name}»`}
                          className={`w-full ${!m.target && !m.mixed ? 'border-[var(--color-warning)]' : ''}`} panelClassName={PANEL} />
                        {(m.target || m.mixed) && (
                          <button type="button" onClick={() => setClients(ctx, [c], null)} aria-label="Вернуть к правилу" title="К правилу"
                            className="tap-target shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><RotateCcw size={14} /></button>
                        )}
                      </div>
                      {!m.target && !m.mixed && (repRule.action === 'brak'
                        ? <span className="text-xs text-[var(--color-negative)]">закроется — выберите получателя</span>
                        : <span className="text-xs text-[var(--color-text-muted)]">по правилу шага 2 → {auto?.target != null ? ctx.nameOf(auto.target) : 'не выбрано'}</span>)}
                    </div>
                  )} />
              );
            })}
          </ul>
          {rows.length === 0 && <EmptySearch onReset={() => { setQ(''); setFilter('all'); }} />}
          <KeyHint brak="закрыть" />
        </div>
      )}
    </StepLayout>
  );
}
