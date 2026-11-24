'use client';

import { Avatar } from '@/components/ui/Avatar';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { DISMISSAL_KIND_LABELS, REPEAT_BRAK_REASONS, type DismissalKind, type RepeatBrakReason } from '../types';
import { fmtMln, fmtNum, plural, ruleOf, ruleTargets } from './planMath';
import { WarnBox, card } from './shared';
import type { WizardCtx } from './wizardCtx';

// Панель «Кому сколько» (спека §8): плитки получателей с живым подсчётом; при выделении строк клик
// по плитке (или цифра 1–9) назначает выделенные этому получателю. Плюс контрол правила вида.

export interface Tile { id: number; deals: number; clients?: number; value: number }

const PANEL = 'w-[400px] max-w-[calc(100vw-16px)]';

export function PanelCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className={`${card} flex flex-col gap-3 p-3 sm:p-4`}>
      {title && <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>}
      {children}
    </div>
  );
}

export function RecipientTiles({ ctx, tiles, valueLabel, canAssign, onAssign, hotkeys = true }: {
  ctx: WizardCtx;
  tiles: Tile[];
  /** «LTV» / «сумма» */
  valueLabel: string;
  canAssign: boolean;
  onAssign?: (id: number) => void;
  hotkeys?: boolean;
}) {
  if (!tiles.length) return <p className="text-xs text-[var(--color-text-muted)]">Получателей пока нет.</p>;
  const total = tiles.reduce((s, t) => s + t.value, 0);
  const max = Math.max(...tiles.map(t => t.value), 1);
  const avg = total / tiles.length;
  return (
    <ul className="flex flex-col gap-1.5">
      {canAssign && onAssign && <li className="text-xs text-[var(--color-accent)]">Нажмите на получателя{hotkeys ? ' или цифру' : ''} — выбранные уйдут ему</li>}
      {tiles.map((t, i) => {
        const skew = tiles.length > 1 && avg > 0 && Math.abs(t.value - avg) / avg > 0.25;
        const body = (
          <>
            <div className="flex items-center gap-2">
              <Avatar name={ctx.nameOf(t.id)} size={28} />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{ctx.nameOf(t.id)}</span>
              {hotkeys && i < 9 && <kbd className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-hover)] px-1.5 text-[10px] text-[var(--color-text-muted)]">{i + 1}</kbd>}
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2 text-xs tabular-nums text-[var(--color-text-muted)]">
              <span>{fmtNum(t.deals)} {plural(t.deals, ['сделка', 'сделки', 'сделок'])}{t.clients != null && <> · {fmtNum(t.clients)} зак.</>}</span>
              <span className={skew ? 'text-[var(--color-warning)]' : ''}>{valueLabel} {fmtMln(t.value)}{skew && ' · перекос'}</span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-[var(--color-bg-hover)]">
              <div className="h-1 rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.round((t.value / max) * 100)}%` }} />
            </div>
          </>
        );
        return (
          <li key={t.id}>
            {canAssign && onAssign ? (
              <button type="button" onClick={() => onAssign(t.id)}
                className="block w-full rounded-lg border border-[var(--color-accent)]/50 bg-[var(--color-bg-surface)] p-2 text-left hover:bg-[var(--color-accent-soft)]">{body}</button>
            ) : (
              <div className="rounded-lg border border-[var(--color-border)] p-2">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Сегмент-кнопки (aria-pressed). */
export function Segment<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid gap-1 rounded-lg border border-[var(--color-border)] p-0.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}
            className={`min-h-11 rounded-md px-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${on ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Правило вида: людям / по отделу (/ закрыть — для повторки). */
export function RuleControl({ ctx, kind, freeCount, unit, allowClose, hint }: {
  ctx: WizardCtx; kind: DismissalKind; freeCount: number; unit: [string, string, string]; allowClose?: boolean; hint?: string;
}) {
  const rule = ruleOf(ctx.plan, kind);
  const mode: 'people' | 'dept' | 'close' = allowClose && rule.action === 'brak' ? 'close' : rule.departmentId != null ? 'dept' : 'people';
  const targets = ruleTargets(rule, ctx.deptManagers);
  const noDepts = ctx.deptsReady && ctx.deptOptions.length === 0;
  const isOwn = mode === 'dept' && rule.departmentId === ctx.ownDeptId;
  const missing = mode !== 'close' && (mode === 'people' || ctx.deptsReady) && targets.length === 0;
  const setMode = (m: typeof mode) => {
    if (m === 'close') {
      ctx.setRule(kind, { action: 'brak' });
      if (!ctx.plan.repeatBrakReason) ctx.update(p => ({ ...p, repeatBrakReason: 'nothing_needed' }));
    } else ctx.setRule(kind, { action: 'transfer', departmentId: m === 'dept' ? rule.departmentId ?? ctx.ownDeptId ?? ctx.deptOptions[0]?.value ?? '' : null });
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Segment label={`${DISMISSAL_KIND_LABELS[kind]}: что делать`} value={mode} onChange={setMode}
        options={[
          { value: 'people', label: 'Людям' },
          { value: 'dept', label: 'По отделу', disabled: noDepts || !ctx.deptsReady, title: noDepts ? 'Нет отделов с действующими менеджерами' : undefined },
          ...(allowClose ? [{ value: 'close' as const, label: 'Закрыть' }] : []),
        ]} />
      {mode === 'people' && (
        <SearchMultiSelect options={ctx.recipients} value={rule.targets.map(String)} onChange={v => ctx.setRule(kind, { targets: v.map(Number) })}
          allLabel={ctx.usersReady ? 'Кому? — выберите людей' : 'Загружаю сотрудников…'}
          unitLabel={plural(rule.targets.length, ['получатель', 'получателя', 'получателей'])}
          searchPlaceholder="Имя, должность, отдел…" ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: кому`}
          className={`w-full ${missing ? 'border-[var(--color-negative)]' : ''}`} panelClassName={PANEL} />
      )}
      {mode === 'dept' && (
        <SearchSelect options={ctx.deptOptions} value={rule.departmentId ?? ''} onChange={v => ctx.setRule(kind, { departmentId: v })} searchable
          placeholder={ctx.deptsReady ? 'Выберите отдел' : 'Загружаю отделы…'} disabled={!ctx.deptsReady} searchPlaceholder="Название отдела…"
          ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: отдел`} className={`w-full ${missing ? 'border-[var(--color-negative)]' : ''}`} panelClassName={PANEL} />
      )}
      {mode === 'close' && (
        <>
          <SearchSelect options={REPEAT_BRAK_REASONS.map(r => ({ value: r.value, label: r.label }))} value={ctx.plan.repeatBrakReason ?? 'nothing_needed'}
            onChange={v => ctx.update(p => ({ ...p, repeatBrakReason: v as RepeatBrakReason }))} ariaLabel="Причина закрытия" className="w-full" panelClassName={PANEL} />
          <WarnBox>Сделки уйдут в отказ с этой причиной. Заказчик остаётся в базе.</WarnBox>
        </>
      )}
      {mode !== 'close' && (
        missing ? (
          <span className="text-xs text-[var(--color-negative)]">{mode === 'dept' ? 'В отделе нет действующих менеджеров — выберите другой.' : 'Выберите, кому раздать.'}</span>
        ) : targets.length > 0 ? (
          <span className="text-xs text-[var(--color-text-muted)] break-words">
            {isOwn && <b className="font-medium text-[var(--color-text)]">Отдел уволенного. </b>}
            {hint ?? 'По кругу'}{freeCount > 0 && <> · ~{fmtNum(Math.ceil(freeCount / targets.length))} {plural(Math.ceil(freeCount / targets.length), unit)} каждому</>}
            {mode === 'dept' && <>. Состав отдела возьмётся в момент запуска</>}.
          </span>
        ) : null
      )}
    </div>
  );
}
