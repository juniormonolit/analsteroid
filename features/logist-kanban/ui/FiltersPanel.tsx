'use client';
// Панель «Фильтры» канбана логиста — как у канбана больших чеков (BigFiltersPanel): кнопка со счётчиком,
// на телефоне нижний лист Modal, на компьютере Popover. Состояние — в URL (useLogistFilters).
// Выбор из списков — только SearchSelect / SearchMultiSelect (CLAUDE.md, правило 14).
import { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { DepartmentPicker } from '@/features/reports/ui/FilterBar';
import { Check, Field, MoneyInput, PICK } from '@/features/big-deals-kanban/ui/BigFiltersPanel';
import {
  REQUEST_STATUSES, REQUEST_STATUS_LABEL,
  type BoardResponse, type BoardSort, type OutcomeFilter, type RequestStatus, type SlaFilter,
} from '../engine/requests/contract';
import type { LogistFilterState } from './useLogistFilters';
import { shortName } from './format';

const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors';
export const BTN_IDLE = `${BTN} border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`;
export const BTN_ACTIVE = `${BTN} border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]`;
const FIELD = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm';

export const SORT_OPTIONS: { value: BoardSort; label: string }[] = [
  { value: 'priority', label: 'По приоритету (огонёк)' },
  { value: 'sum', label: 'По сумме — крупные сверху' },
  { value: 'waiting', label: 'По ожиданию — дольше ждут сверху' },
  { value: 'created', label: 'По созданию — новые сверху' },
];
const SLA_OPTIONS = [{ value: 'hot', label: 'Горит (и просрочен)' }, { value: 'overdue', label: 'Только просрочен' }];
const OUTCOME_OPTIONS = [{ value: 'open', label: 'Сделка ещё открыта' }, { value: 'sold', label: 'Продана' }, { value: 'lost', label: 'Забракована' }];
const STATUS_OPTIONS = REQUEST_STATUSES.filter(s => s !== 'draft').map(s => ({ value: s, label: REQUEST_STATUS_LABEL[s] }));

function PanelBody({ s, options, onDone }: { s: LogistFilterState; options: BoardResponse['options'] | undefined; onDone?: () => void }) {
  const f = s.filters;
  const o = options;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Field label="Сортировка карточек в колонках">
        <SearchSelect ariaLabel="Сортировка" value={f.sort ?? 'priority'} onChange={v => s.set('sort', v === 'priority' ? undefined : v as BoardSort)} options={SORT_OPTIONS} className={PICK} />
      </Field>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Очередь (проект)">
          <SearchMultiSelect ariaLabel="Очередь" allLabel="Все очереди" unitLabel="очередей" searchPlaceholder="Поиск очереди" className={PICK}
            options={(o?.queues ?? []).map(q => ({ value: String(q.id), label: q.name, hint: [q.region, q.dept].filter(Boolean).join(' · ') || null }))}
            value={(f.queues ?? []).map(String)} onChange={v => s.set('queues', v.map(Number))} />
        </Field>
        <Field label="Товарная группа">
          <SearchMultiSelect ariaLabel="Товарная группа" allLabel="Любая" unitLabel="групп" searchPlaceholder="Поиск группы" className={PICK}
            options={(o?.productGroups ?? []).map(g => ({ value: g, label: g }))} value={f.productGroups ?? []} onChange={v => s.set('productGroups', v)} />
        </Field>
        <Field label="Регион">
          <SearchMultiSelect ariaLabel="Регион" allLabel="Все регионы" unitLabel="регионов" className={PICK}
            options={(o?.regions ?? []).map(r => ({ value: r, label: r }))} value={f.regions ?? []} onChange={v => s.set('regions', v)} />
        </Field>
        <Field label="Департамент">
          <SearchMultiSelect ariaLabel="Департамент" allLabel="ОС и НЦ" unitLabel="департаментов" className={PICK}
            options={(o?.depts ?? []).map(d => ({ value: d, label: d }))} value={f.depts ?? []} onChange={v => s.set('depts', v)} />
        </Field>
        <Field label="Менеджер">
          <SearchMultiSelect ariaLabel="Менеджер" allLabel="Все менеджеры" unitLabel="менеджеров" searchPlaceholder="Поиск менеджера" className={PICK}
            options={(o?.managers ?? []).map(m => ({ value: m.bitrixId, label: m.name ?? `id ${m.bitrixId}` }))} value={f.managers ?? []} onChange={v => s.set('managers', v)} />
        </Field>
        <Field label="Отдел менеджера">
          <DepartmentPicker departmentIds={f.managerDepts ?? []} onDepartmentIdsChange={ids => s.set('managerDepts', ids)}
            triggerClassName={`${PICK} ${(f.managerDepts?.length ?? 0) > 0 ? 'border-[var(--color-accent)]' : ''}`} />
        </Field>
        <Field label="Логист">
          <SearchMultiSelect ariaLabel="Логист" allLabel="Все логисты" unitLabel="логистов" searchPlaceholder="Поиск логиста" className={PICK}
            options={(o?.logists ?? []).map(m => ({ value: m.bitrixId, label: m.name ?? `id ${m.bitrixId}` }))} value={f.logists ?? []} onChange={v => s.set('logists', v)} />
        </Field>
        <Field label="Статус запроса">
          <SearchMultiSelect ariaLabel="Статус" allLabel="Любой" unitLabel="статусов" className={PICK}
            options={STATUS_OPTIONS} value={f.statuses ?? []} onChange={v => s.set('statuses', v as RequestStatus[])} />
        </Field>
        <Field label="SLA">
          <SearchSelect ariaLabel="SLA" allLabel="Любой" value={f.sla ?? ''} onChange={v => s.set('sla', (v || undefined) as SlaFilter | undefined)} options={SLA_OPTIONS} className={PICK} />
        </Field>
        <Field label="Исход сделки">
          <SearchSelect ariaLabel="Исход сделки" allLabel="Любой" value={f.outcome ?? ''} onChange={v => s.set('outcome', (v || undefined) as OutcomeFilter | undefined)} options={OUTCOME_OPTIONS} className={PICK} />
        </Field>
      </div>
      <Field label="Сумма, ₽">
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <MoneyInput live value={f.sumMin} onChange={v => s.set('sumMin', v ?? undefined)} placeholder="от" label="Сумма от" />
          <MoneyInput live value={f.sumMax} onChange={v => s.set('sumMax', v ?? undefined)} placeholder="до" label="Сумма до" />
        </div>
      </Field>
      <Field label="Запрос создан">
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <input type="date" value={f.createdFrom ?? ''} max={f.createdTo || undefined} onChange={e => s.set('createdFrom', e.target.value || undefined)} aria-label="Создан с"
            className={`${FIELD} ${f.createdFrom ? 'border-[var(--color-accent)]' : ''}`} />
          <input type="date" value={f.createdTo ?? ''} min={f.createdFrom || undefined} onChange={e => s.set('createdTo', e.target.value || undefined)} aria-label="Создан по"
            className={`${FIELD} ${f.createdTo ? 'border-[var(--color-accent)]' : ''}`} />
        </div>
      </Field>
      <Check checked={!!f.returned} onChange={v => s.set('returned', v || undefined)}>Были возвраты на доработку</Check>
      <div className="flex min-w-0 flex-wrap justify-between gap-2">
        {s.panelActive > 0 ? (
          <button type="button" onClick={s.resetPanel} className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">Сбросить фильтры</button>
        ) : <span />}
        {onDone && <button type="button" onClick={onDone} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm text-white">Готово</button>}
      </div>
    </div>
  );
}

export function FiltersButton({ s, options }: { s: LogistFilterState; options: BoardResponse['options'] | undefined }) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const trigger = (
    <button type="button" onClick={isMobile ? () => setOpen(true) : undefined} className={s.panelActive ? BTN_ACTIVE : BTN_IDLE}
      aria-label="Фильтры" title="Очередь, регион, группа, менеджер, логист, статус, SLA, сумма, период, исход, сортировка">
      <SlidersHorizontal size={16} aria-hidden /> <span>Фильтры</span>{s.panelActive ? <span className="tabular-nums">{s.panelActive}</span> : null}
    </button>
  );
  if (isMobile) {
    return (
      <>
        {trigger}
        <Modal open={open} onOpenChange={setOpen} title="Фильтры" desktopWidth="sm:max-w-md">
          <PanelBody s={s} options={options} onDone={() => setOpen(false)} />
        </Modal>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen} align="start" className="w-[560px] max-w-[calc(100vw-16px)] p-3" trigger={trigger}>
      <div className="max-h-[75dvh] overflow-y-auto overflow-x-hidden">
        <PanelBody s={s} options={options} />
      </div>
    </Popover>
  );
}

export function ResetAllButton({ s, onReset }: { s: LogistFilterState; onReset?: () => void }) {
  if (!s.anyActive) return null;
  return <button type="button" onClick={() => { s.resetAll(); onReset?.(); }} className={BTN_IDLE}><X size={14} aria-hidden />Сбросить</button>;
}

/** Активные фильтры панели чипами под строкой управления — видно, что доска сужена. */
export function ActiveChips({ s, options }: { s: LogistFilterState; options: BoardResponse['options'] | undefined }) {
  const f = s.filters;
  const chips: { key: string; label: string; clear: () => void }[] = [];
  const nameOf = (list: { bitrixId: string; name: string | null }[] | undefined, id: string) => shortName(list?.find(x => x.bitrixId === id)?.name ?? `id ${id}`);
  const many = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, 2).join(', ')} +${xs.length - 2}` : xs.join(', '));
  if (f.queues?.length) chips.push({ key: 'q', label: `Очередь: ${many(f.queues.map(id => options?.queues.find(q => q.id === id)?.name ?? `#${id}`))}`, clear: () => s.set('queues', undefined) });
  if (f.productGroups?.length) chips.push({ key: 'pg', label: `Группа: ${many(f.productGroups)}`, clear: () => s.set('productGroups', undefined) });
  if (f.regions?.length) chips.push({ key: 'r', label: `Регион: ${many(f.regions)}`, clear: () => s.set('regions', undefined) });
  if (f.depts?.length) chips.push({ key: 'd', label: `Департамент: ${many(f.depts)}`, clear: () => s.set('depts', undefined) });
  if (f.managers?.length) chips.push({ key: 'm', label: `Менеджер: ${many(f.managers.map(id => nameOf(options?.managers, id)))}`, clear: () => s.set('managers', undefined) });
  if (f.managerDepts?.length) chips.push({ key: 'md', label: `Отделов: ${f.managerDepts.length}`, clear: () => s.set('managerDepts', undefined) });
  if (f.logists?.length) chips.push({ key: 'l', label: `Логист: ${many(f.logists.map(id => nameOf(options?.logists, id)))}`, clear: () => s.set('logists', undefined) });
  if (f.statuses?.length) chips.push({ key: 's', label: `Статус: ${many(f.statuses.map(x => REQUEST_STATUS_LABEL[x]))}`, clear: () => s.set('statuses', undefined) });
  if (f.sla) chips.push({ key: 'sla', label: f.sla === 'overdue' ? 'SLA просрочен' : 'SLA горит', clear: () => s.set('sla', undefined) });
  if (f.returned) chips.push({ key: 'ret', label: 'С возвратами', clear: () => s.set('returned', undefined) });
  if (f.sumMin || f.sumMax) chips.push({ key: 'sum', label: `Сумма ${f.sumMin ? `от ${f.sumMin.toLocaleString('ru-RU')}` : ''} ${f.sumMax ? `до ${f.sumMax.toLocaleString('ru-RU')}` : ''}`.trim(), clear: () => { const n = { ...f }; delete n.sumMin; delete n.sumMax; s.replace(n); } });
  if (f.createdFrom || f.createdTo) chips.push({ key: 'per', label: `Создан ${f.createdFrom ? `с ${f.createdFrom.split('-').reverse().join('.')}` : ''} ${f.createdTo ? `по ${f.createdTo.split('-').reverse().join('.')}` : ''}`.trim(), clear: () => { const n = { ...f }; delete n.createdFrom; delete n.createdTo; s.replace(n); } });
  if (f.outcome) chips.push({ key: 'out', label: OUTCOME_OPTIONS.find(x => x.value === f.outcome)?.label ?? f.outcome, clear: () => s.set('outcome', undefined) });
  if (f.sort) chips.push({ key: 'sort', label: SORT_OPTIONS.find(x => x.value === f.sort)?.label ?? f.sort, clear: () => s.set('sort', undefined) });
  if (!chips.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="Включённые фильтры">
      {chips.map(c => (
        <span key={c.key} className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-[var(--color-accent)] bg-[var(--color-accent-soft)] pl-3 pr-1 text-xs text-[var(--color-accent)]">
          <span className="min-w-0 truncate">{c.label}</span>
          <button type="button" onClick={c.clear} aria-label={`Убрать: ${c.label}`} className="tap-target rounded-full p-1 hover:bg-[var(--color-bg-hover)]"><X size={12} /></button>
        </span>
      ))}
    </div>
  );
}
