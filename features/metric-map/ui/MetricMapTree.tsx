'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Info, RotateCcw, SlidersHorizontal, Target } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { MapNodeDef, MapNodeValue } from '../types';
import type { MapResult } from './api';
import { fmtDelta, fmtRub, fmtValue, fromInput, isMultiplier, sliderRange, toInput, type TreeIndex } from './tree';

// Дерево «Карты показателей» — один и тот же раскрывающийся список с отступами на всех
// ширинах (CLAUDE.md: на 375px — не широкая схема). На десктопе (lg) цифры узла
// выстраиваются колонками под общей шапкой — читается как дерево-таблица; на телефоне
// под названием переносятся подписанными «чипами».

const COLS = 'lg:grid lg:grid-cols-[120px_96px_132px_120px_120px] lg:gap-x-3';

export function TreeHeader() {
  return (
    <div className="hidden lg:flex items-end gap-3 px-3 pb-1.5 text-[11px] font-medium text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
      <div className="flex-1 min-w-0">Показатель</div>
      <div className={`${COLS} text-right`}>
        <div>Значение</div>
        <div>к пред. периоду</div>
        <div>Медиана команды</div>
        <div>Вклад в Δ, ₽</div>
        <div>До медианы, ₽</div>
      </div>
    </div>
  );
}

interface TreeProps {
  data: MapResult;
  idx: TreeIndex;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  whatIf: boolean;
  scenario: Record<string, number | null>;
  overrides: Record<string, number>;
  onOverride: (id: string, v: number | null) => void;
}

export function MetricMapTree(props: TreeProps) {
  return (
    <div className="flex flex-col">
      <TreeHeader />
      <NodeBranch {...props} id={props.data.rootId} depth={0} sign={null} />
    </div>
  );
}

function NodeBranch(props: TreeProps & { id: string; depth: number; sign: '+' | '×' | null }) {
  const { data, idx, id, depth, collapsed } = props;
  const def = idx.byId.get(id);
  if (!def) return null;
  const v = data.values[id];
  const kids = def.children ?? [];
  const open = !collapsed.has(id);
  const childSign = def.kind === 'sum' ? '+' : def.kind === 'product' ? '×' : null;
  const showResidual = depth === 0 && data.residual != null && Math.abs(data.residual) > Math.max(1, Math.abs(v?.value ?? 0) * 0.0005);
  return (
    <div>
      <NodeRow {...props} def={def} v={v} open={open} />
      {kids.length > 0 && open && (
        <div className="ml-[13px] lg:ml-[17px] border-l border-dashed border-[var(--color-border-strong)] pl-1.5 lg:pl-3">
          {kids.map(c => <NodeBranch key={c} {...props} id={c} depth={depth + 1} sign={childSign} />)}
          {showResidual && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-muted)]">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-[11px]">±</span>
              <span className="flex-1 min-w-0">Невязка: факт минус собранное по дереву (округления, неполные данные)</span>
              <span className="tabular-nums font-medium text-[var(--color-text)]">{fmtRub(data.residual!, true)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NodeRow({ def, v, open, depth, sign, idx, onToggle, whatIf, scenario, overrides, onOverride, data }: TreeProps & {
  def: MapNodeDef; v: MapNodeValue | undefined; open: boolean; depth: number; sign: '+' | '×' | null;
}) {
  const hasKids = !!def.children?.length;
  const value = v?.value ?? null;
  const scen = scenario[def.id];
  const changed = whatIf && scen != null && value != null && Math.abs(scen - value) > Math.abs(value) * 1e-9;
  const delta = fmtDelta(value, v?.prev ?? null, def.unit);
  const median = v?.teamMedian ?? null;
  const vsMedian = value != null && median != null ? (value > median * 1.0001 ? 1 : value < median * 0.9999 ? -1 : 0) : null;
  const canEdit = whatIf && isMultiplier(idx, def.id) && value != null;
  const isRoot = depth === 0;
  const [editing, setEditing] = useState(false);
  const editorOpen = canEdit && (editing || overrides[def.id] != null);

  return (
    <div className={`rounded-lg ${isRoot ? 'bg-[var(--color-bg-surface)] border border-[var(--color-border)]' : 'hover:bg-[var(--color-bg-hover)]'} ${v?.lowSample ? 'opacity-60' : ''}`}>
      <div className="flex flex-col lg:flex-row lg:items-center gap-1 lg:gap-3 px-2 lg:px-3 py-2">
        {/* Название */}
        <div className="flex items-start gap-1 min-w-0 flex-1">
          {hasKids ? (
            <button type="button" onClick={() => onToggle(def.id)} aria-expanded={open} aria-label={open ? 'Свернуть' : 'Раскрыть'}
              className="tap-target mt-0.5 shrink-0 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          ) : <span className="w-4 shrink-0" />}
          {sign && (
            <span title={sign === '+' ? 'Слагаемое: родитель = сумма' : 'Множитель: родитель = произведение'}
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-[12px] font-semibold text-[var(--color-accent)]">
              {sign}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-sm ${isRoot ? 'font-semibold' : hasKids ? 'font-medium' : ''} text-[var(--color-text)]`}>{def.label}</span>
              <NodeInfo def={def} v={v} />
              {hasKids && (def.kind === 'sum' || def.kind === 'product') && (
                <span className="rounded px-1.5 py-px text-[10px] font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] whitespace-nowrap">
                  {def.kind === 'sum' ? 'Σ сумма' : '× произведение'}
                </span>
              )}
              {canEdit && (
                <button type="button" onClick={() => setEditing(e => !e)} aria-expanded={editorOpen}
                  className={`min-h-11 sm:min-h-0 sm:py-0.5 inline-flex items-center gap-1 rounded px-1.5 text-[11px] border ${editorOpen ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]'}`}>
                  <SlidersHorizontal size={12} /> изменить
                </button>
              )}
              {v?.lowSample && (
                <span className="rounded px-1.5 py-px text-[10px] bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] whitespace-nowrap">
                  мало данных{v.sampleSize != null ? ` · n=${Math.round(v.sampleSize)}` : ''}
                </span>
              )}
            </div>
            {v?.share != null && (
              <div className="mt-1 flex items-center gap-2 max-w-[260px]">
                <div className="h-1 flex-1 rounded bg-[var(--color-bg-hover)] overflow-hidden">
                  <div className="h-full rounded bg-[var(--color-accent)]/70" style={{ width: `${Math.min(100, Math.max(1, v.share * 100))}%` }} />
                </div>
                <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{fmtValue(v.share, 'pct')} родителя</span>
              </div>
            )}
          </div>
        </div>

        {/* Цифры */}
        <div className={`pl-5 lg:pl-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs ${COLS} lg:text-right`}>
          <Cell caption="">
            <span className={`text-sm font-semibold tabular-nums ${changed ? 'line-through text-[var(--color-text-muted)] font-normal' : 'text-[var(--color-text)]'}`}>
              {fmtValue(value, def.unit)}
            </span>
            {changed && <span className="block text-sm font-semibold tabular-nums text-[var(--color-accent)]">→ {fmtValue(scen, def.unit)}</span>}
          </Cell>
          <Cell caption="к пред.:">
            {delta ? (
              <span className={`tabular-nums ${delta.sign > 0 ? 'text-[var(--color-positive)]' : delta.sign < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}
                title={`Было: ${fmtValue(v?.prev ?? null, def.unit)} (${data.comparePeriod.label})`}>
                {delta.text}
              </span>
            ) : <span className="text-[var(--color-text-muted)]">—</span>}
          </Cell>
          <Cell caption="медиана:">
            {median != null ? (
              <span className="tabular-nums text-[var(--color-text-secondary)]">
                {fmtValue(median, def.unit)}{' '}
                {vsMedian != null && vsMedian !== 0 && (
                  <span className={vsMedian > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}
                    title={vsMedian > 0 ? 'Выше медианы команды' : 'Ниже медианы команды'}>
                    {vsMedian > 0 ? '▲' : '▼'}
                  </span>
                )}
              </span>
            ) : <span className="text-[var(--color-text-muted)]">—</span>}
          </Cell>
          <Cell caption="вклад:">
            {v?.contribution != null && !isRoot ? (
              <span className={`tabular-nums font-medium ${v.contribution > 0 ? 'text-[var(--color-positive)]' : v.contribution < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}>
                {fmtRub(v.contribution, true)}
              </span>
            ) : isRoot && v?.value != null && v.prev != null ? (
              <span className={`tabular-nums font-medium ${v.value >= v.prev ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>{fmtRub(v.value - v.prev, true)}</span>
            ) : <span className="text-[var(--color-text-muted)]">—</span>}
          </Cell>
          <Cell caption="до медианы:">
            {v?.potential != null && v.potential > 0
              ? <span className="tabular-nums text-[var(--color-accent)]">{fmtRub(v.potential, true)}</span>
              : <span className="text-[var(--color-text-muted)]">—</span>}
          </Cell>
        </div>
      </div>

      {editorOpen && (
        <WhatIfEditor def={def} value={value!} median={median} override={overrides[def.id]} onChange={x => { onOverride(def.id, x); if (x == null) setEditing(false); }} />
      )}
    </div>
  );
}

/** Подпись ячейки видна только на телефоне/планшете — на lg есть общая шапка. */
function Cell({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 whitespace-nowrap">
      {caption && <span className="lg:hidden text-[var(--color-text-muted)] mr-1">{caption}</span>}
      {children}
    </div>
  );
}

function NodeInfo({ def, v }: { def: MapNodeDef; v: MapNodeValue | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[320px] max-w-[calc(100vw-16px)]"
      trigger={
        <button type="button" aria-label="Как считается" className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">
          <Info size={13} />
        </button>
      }
    >
      <div className="p-3 flex flex-col gap-2 text-xs">
        <div className="font-medium text-sm text-[var(--color-text)]">{def.label}</div>
        <div>
          <div className="text-[11px] text-[var(--color-text-muted)]">Формула</div>
          <div className="text-[var(--color-text)]">{def.formula}</div>
        </div>
        {def.description && <p className="text-[var(--color-text-secondary)] leading-snug">{def.description}</p>}
        {v?.sampleSize != null && (
          <div className="text-[11px] text-[var(--color-text-muted)]">
            Выборка: {Math.round(v.sampleSize).toLocaleString('ru-RU')}
            {def.minSample != null && ` (порог ${def.minSample})`}
            {v.lowSample && ' — мало данных, значение ненадёжно'}
          </div>
        )}
      </div>
    </Popover>
  );
}

function WhatIfEditor({ def, value, median, override, onChange }: {
  def: MapNodeDef; value: number; median: number | null; override: number | undefined; onChange: (v: number | null) => void;
}) {
  const cur = override ?? value;
  const r = sliderRange(value, def.unit, median);
  const suffix = def.unit === 'pct' ? '%' : def.unit === 'rub' ? '₽' : def.unit === 'count' ? 'шт' : '';
  return (
    <div className="mx-2 lg:mx-3 mb-2 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]/40 px-3 py-2 flex flex-col sm:flex-row sm:items-center gap-2">
      <input
        type="range" min={r.min} max={r.max} step={r.step} value={Math.min(r.max, Math.max(r.min, cur))}
        onChange={e => onChange(Number(e.target.value))}
        aria-label={`Что если: ${def.label}`}
        className="w-full sm:flex-1 min-h-11 accent-[var(--color-accent)]"
      />
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1">
          <input
            type="number" inputMode="decimal" step="any"
            value={toInput(cur, def.unit)}
            onChange={e => { const n = Number(e.target.value.replace(',', '.')); if (Number.isFinite(n)) onChange(fromInput(n, def.unit)); }}
            className="w-28 min-h-11 sm:min-h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-base sm:text-sm tabular-nums text-right"
          />
          {suffix && <span className="text-xs text-[var(--color-text-muted)]">{suffix}</span>}
        </label>
        {median != null && (
          <button type="button" onClick={() => onChange(median)}
            className="min-h-11 sm:min-h-9 inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs hover:bg-[var(--color-bg-hover)]">
            <Target size={13} /> До медианы
          </button>
        )}
        {override != null && (
          <button type="button" onClick={() => onChange(null)}
            className="min-h-11 sm:min-h-9 inline-flex items-center gap-1 rounded-md px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            <RotateCcw size={13} /> Факт
          </button>
        )}
      </div>
    </div>
  );
}
