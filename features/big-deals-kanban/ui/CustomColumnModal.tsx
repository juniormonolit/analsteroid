'use client';
// «Свои колонки» во вкладке «Сегодня» канбана больших чеков (владелец 18.11: «фишки повторки»). Колонка = название +
// набор условий BigFilters; хранится у пользователя (API /api/big-deals-kanban/columns, GET/POST/PATCH/DELETE). Не больше 5.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { BigColumnKey } from '../engine/config';
import type { BigCustomColumn, BigFilters, BigTaskState } from '../engine/types';
import { COLUMN_OPTIONS, DEAL_OPTIONS, STATE_OPTIONS, cleanFilters } from './filters';
import { Check, DaysInput, FIELD, Field, MoneyInput, PICK } from './BigFiltersPanel';

export const MAX_CUSTOM_COLUMNS = 5;

const PRESETS: { name: string; f: BigFilters }[] = [
  { name: 'Крупные без звонков', f: { sumMin: 1_000_000, noCalls: true, deal: 'open' } },
  { name: 'Бронь висит', f: { columns: ['reserve', 'reserve_confirmed', 'invoice'], daysMin: 5 } },
  { name: 'Завалы: не трогали неделю', f: { idleDaysMin: 7, deal: 'open' } },
];

export type CustomSaveFn = (draft: { id?: string; name: string; filters: BigFilters }) => Promise<void>;
export type CustomDeleteFn = (id: string) => Promise<void>;

export function CustomColumnModal({ initial, groups, productGroups, onSave, onDelete, onClose }: {
  initial: BigCustomColumn | null;
  groups: { id: number; short: string; name: string }[];
  productGroups: string[];
  onSave: CustomSaveFn;
  onDelete: CustomDeleteFn;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [f, setF] = useState<BigFilters>(initial?.filters ?? {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const set = (patch: Partial<BigFilters>) => setF(prev => cleanFilters({ ...prev, ...patch }));
  const empty = Object.keys(cleanFilters(f)).length === 0;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <Modal open onOpenChange={o => { if (!o && !busy) onClose(); }} title={initial ? `Своя колонка · ${initial.name}` : 'Новая колонка в «Сегодня»'} desktopWidth="sm:max-w-lg">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <Field label="Название">
          <input value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="Крупные без звонков" className={FIELD} />
        </Field>
        {!initial && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            <span className="w-full text-xs text-[var(--color-text-muted)]">Заготовки — заполнят условия ниже:</span>
            {PRESETS.map(p => (
              <button key={p.name} type="button" onClick={() => { setF(p.f); if (!name.trim()) setName(p.name); }}
                className="min-h-11 rounded-full border border-[var(--color-border)] px-3 text-[13px] text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">{p.name}</button>
            ))}
          </div>
        )}

        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Проекты">
            <SearchMultiSelect ariaLabel="Проекты" allLabel="Все проекты" unitLabel="проектов" searchPlaceholder="Поиск"
              options={groups.map(g => ({ value: String(g.id), label: g.short, hint: g.name }))}
              value={(f.groups ?? []).map(String)} onChange={v => set({ groups: v.map(Number) })} className={PICK} />
          </Field>
          <Field label="Колонки доски">
            <SearchMultiSelect ariaLabel="Колонки доски" allLabel="Любая колонка" unitLabel="колонок" searchPlaceholder="Поиск колонки"
              options={COLUMN_OPTIONS} value={f.columns ?? []} onChange={v => set({ columns: v as BigColumnKey[] })} className={PICK} />
          </Field>
        </div>
        {productGroups.length > 0 && (
          <Field label="Товарные группы">
            <SearchMultiSelect ariaLabel="Товарные группы" allLabel="Любая" unitLabel="групп" searchPlaceholder="Поиск группы"
              options={productGroups.map(p => ({ value: p, label: p }))} value={f.products ?? []} onChange={v => set({ products: v })} className={PICK} />
          </Field>
        )}
        <Field label="Сумма сделки, ₽">
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <MoneyInput value={f.sumMin} onChange={v => set({ sumMin: v })} placeholder="от" label="Сумма от" />
            <MoneyInput value={f.sumMax} onChange={v => set({ sumMax: v })} placeholder="до" label="Сумма до" />
          </div>
        </Field>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Статус задачи">
            <SearchMultiSelect ariaLabel="Статус задачи" allLabel="Любой" unitLabel="статусов" searchPlaceholder="Поиск"
              options={STATE_OPTIONS} value={f.states ?? []} onChange={v => set({ states: v as BigTaskState[] })} className={PICK} />
          </Field>
          <Field label="Сделка">
            <SearchSelect ariaLabel="Сделка" value={f.deal ?? ''} onChange={v => set({ deal: v === 'won' || v === 'lost' || v === 'open' ? v : null })}
              options={DEAL_OPTIONS} className={PICK} />
          </Field>
          <Field label="Дней в колонке ≥">
            <DaysInput value={f.daysMin} onChange={v => set({ daysMin: v })} label="Дней в колонке не меньше" />
          </Field>
          <Field label="Не менялась, дней ≥">
            <DaysInput value={f.idleDaysMin} onChange={v => set({ idleDaysMin: v })} label="Не менялась дней не меньше" />
          </Field>
        </div>
        <div className="flex min-w-0 flex-col">
          <Check checked={!!f.stuck} onChange={v => set({ stuck: v })}>Застряли — дольше нормы в колонке</Check>
          <Check checked={!!f.noCalls} onChange={v => set({ noCalls: v })}>Звонков после постановки не было</Check>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          {empty ? 'Задайте хотя бы одно условие.' : 'Колонка покажет задачи, подходящие под все условия сразу, с учётом проектов и менеджера, выбранных на доске.'}
        </p>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          {initial ? (
            confirmDel ? (
              <span className="flex flex-wrap items-center gap-1">
                <span className="text-[var(--color-text-secondary)]">Удалить колонку?</span>
                <button type="button" disabled={busy} onClick={() => run(() => onDelete(initial.id))}
                  className="min-h-11 rounded-lg px-3 font-medium text-[var(--color-negative)] hover:bg-[var(--color-negative-soft)]">Да, удалить</button>
                <button type="button" onClick={() => setConfirmDel(false)} className="min-h-11 rounded-lg px-3 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Нет</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmDel(true)} className="min-h-11 rounded-lg px-3 text-[var(--color-negative)] hover:bg-[var(--color-negative-soft)]">Удалить</button>
            )
          ) : <span />}
          <span className="flex gap-2">
            <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
            <button type="button" disabled={busy || empty || name.trim().length < 2}
              onClick={() => run(() => onSave({ id: initial?.id, name: name.trim(), filters: cleanFilters(f) }))}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'Сохранить'}</button>
          </span>
        </div>
      </div>
    </Modal>
  );
}

export function AddColumnTile({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={disabled ? `Не больше ${MAX_CUSTOM_COLUMNS} своих колонок` : 'Своя колонка: задачи по вашим условиям'}
      className="flex h-full min-h-40 w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50 sm:w-40">
      <Plus size={18} aria-hidden /> Своя колонка
    </button>
  );
}
