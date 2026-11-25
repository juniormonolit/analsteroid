'use client';
// Панель «Фильтры» канбана больших чеков (как в повторке: кнопка со счётчиком активных; на телефоне — нижний лист Modal,
// на компьютере — Popover). Всё состояние — в URL (useUrlState) и уходит в GET доски одним набором BigFilters.
import { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { boolParam, enumParam, listParam, stringParam, useUrlState, useUrlStateBatch } from '@/lib/hooks/useUrlState';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { BigFilters, BigSort, BigTaskState } from '../engine/types';
import { DEAL_OPTIONS, SORT_OPTIONS, SORTS, STATE_OPTIONS } from './filters';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
export const FIELD = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm';
export const PICK = 'inline-flex min-h-11 w-full min-w-0 items-center justify-start gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]';
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors';
const BTN_IDLE = `${BTN} border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`;
const BTN_ACTIVE = `${BTN} border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]`;

const productsParam = {
  ...listParam([]),
  // Через «|»: в названиях товарных групп бывают запятые («Бордюры (поребрики, бортовые камни)»).
  parse: (raw: string) => (raw === '' ? [] : raw.split('|').filter(Boolean)),
  serialize: (v: string[]) => { const d = [...new Set(v)]; return d.length ? d.join('|') : null; },
};
const posInt = (s: string) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
const isDay = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

/** Все фильтры доски в URL. Ключи URL = ключи API (filtersToParams). */
export function useBigFilters() {
  const [groupSel, setGroupSel] = useUrlState('group', listParam([]));
  const [manager, setManager] = useUrlState('manager', stringParam(''));
  const [products, setProducts] = useUrlState('product', productsParam);
  const [q, setQ] = useUrlState('q', stringParam(''));
  const [smin, setSmin] = useUrlState('smin', stringParam(''));
  const [smax, setSmax] = useUrlState('smax', stringParam(''));
  const [cfrom, setCfrom] = useUrlState('cfrom', stringParam(''));
  const [cto, setCto] = useUrlState('cto', stringParam(''));
  const [states, setStates] = useUrlState('states', listParam([]));
  const [idle, setIdle] = useUrlState('idle', stringParam(''));
  const [stuck, setStuck] = useUrlState('stuck', boolParam(false));
  const [noCalls, setNoCalls] = useUrlState('nocalls', boolParam(false));
  const [deal, setDeal] = useUrlState('deal', stringParam(''));
  const [sort, setSort] = useUrlState('sort', enumParam(SORTS, 'default'));
  // Кнопка «Ждёт контроля» на доске (владелец 18.11): статус «ждёт контроля» БЕЗ колонок «Не продано» — там тысячи старых отказов.
  const [ctl, setCtl] = useUrlState('ctl', boolParam(false));
  // Кнопка «Нераспределённые» (РОП Осипов 19.11): открытые задачи, где менеджер не назначен (висят на РОПе/директоре).
  const [unas, setUnas] = useUrlState('unas', boolParam(false));
  // Кнопка «Новое» (владелец 25.11): только карточки, где есть новое с прошлого открытия.
  const [fresh, setFresh] = useUrlState('fresh', boolParam(false));
  const batch = useUrlStateBatch();

  const filters = useMemo<BigFilters>(() => ({
    groups: groupSel.map(Number).filter(n => n > 0),
    manager: manager || null,
    products,
    q: q || null,
    sumMin: posInt(smin), sumMax: posInt(smax),
    createdFrom: isDay(cfrom), createdTo: isDay(cto),
    states: ctl ? ['control'] as BigTaskState[] : states as BigTaskState[],
    hideLost: ctl || undefined,
    unassigned: unas || undefined,
    fresh: fresh || undefined,
    idleDaysMin: posInt(idle),
    stuck, noCalls,
    deal: deal === 'won' || deal === 'lost' || deal === 'open' ? deal : null,
  }), [groupSel, manager, products, q, smin, smax, cfrom, cto, states, idle, stuck, noCalls, deal, ctl, unas, fresh]);

  /** Сколько условий включено в панели «Фильтры» (проекты/менеджер/группы/поиск — на виду, не считаем). */
  const panelActive = [smin || smax, cfrom || cto, states.length, idle, stuck, noCalls, deal, sort !== 'default'].filter(Boolean).length;
  const anyActive = ctl || unas || fresh || panelActive > 0 || groupSel.length > 0 || !!manager || products.length > 0 || !!q;

  const resetPanel = () => batch({ smin: null, smax: null, cfrom: null, cto: null, states: null, idle: null, stuck: null, nocalls: null, deal: null, sort: null });
  const resetAll = () => batch({ ctl: null, unas: null, fresh: null, group: null, manager: null, product: null, q: null, smin: null, smax: null, cfrom: null, cto: null, states: null, idle: null, stuck: null, nocalls: null, deal: null, sort: null });

  return {
    filters, sort: sort as BigSort, panelActive, anyActive, resetPanel, resetAll,
    groupSel, setGroupSel, manager, setManager, products, setProducts, q, setQ,
    smin, setSmin, smax, setSmax, cfrom, setCfrom, cto, setCto, states, setStates, idle, setIdle,
    stuck, setStuck, noCalls, setNoCalls, deal, setDeal, setSort, ctl, setCtl, unas, setUnas, fresh, setFresh,
  };
}
export type BigFilterState = ReturnType<typeof useBigFilters>;

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-[var(--color-text-muted)]">{label}</span>
      {children}
    </div>
  );
}

/** Сумма в ₽ с пробелами-разделителями; наружу — число. Применяется по паузе (live) или по blur. */
export function MoneyInput({ value, onChange, placeholder, label, live = false }: {
  value: number | null | undefined; onChange: (v: number | null) => void; placeholder: string; label: string; live?: boolean;
}) {
  const [draft, setDraft] = useState(value ? rub.format(value) : '');
  useEffect(() => { setDraft(value ? rub.format(value) : ''); }, [value]);
  const commit = (d: string) => { const n = Number(d.replace(/\D/g, '').slice(0, 12)); const v = n > 0 ? n : null; if (v !== (value ?? null)) onChange(v); };
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => commit(draft), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, live]);
  return (
    <input value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => commit(draft)} inputMode="numeric" placeholder={placeholder} aria-label={label}
      className={`${FIELD} tabular-nums ${value ? 'border-[var(--color-accent)]' : ''}`} />
  );
}

/** Целое число дней (≥ N). */
export function DaysInput({ value, onChange, label, placeholder = 'не важно' }: { value: number | null | undefined; onChange: (v: number | null) => void; label: string; placeholder?: string }) {
  return (
    <input type="number" inputMode="numeric" min={1} max={365} value={value ?? ''} placeholder={placeholder} aria-label={label}
      onChange={e => { const n = Number(e.target.value); onChange(n > 0 ? Math.min(365, Math.round(n)) : null); }}
      className={`${FIELD} tabular-nums ${value ? 'border-[var(--color-accent)]' : ''}`} />
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-text)]">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

function DateRange({ from, to, onFrom, onTo }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2">
      <input type="date" value={from} max={to || undefined} onChange={e => onFrom(e.target.value)} aria-label="Создана с" className={`${FIELD} ${from ? 'border-[var(--color-accent)]' : ''}`} />
      <input type="date" value={to} min={from || undefined} onChange={e => onTo(e.target.value)} aria-label="Создана по" className={`${FIELD} ${to ? 'border-[var(--color-accent)]' : ''}`} />
    </div>
  );
}

function PanelBody({ s, onDone }: { s: BigFilterState; onDone?: () => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Field label="Сортировка карточек в колонках">
        <SearchSelect ariaLabel="Сортировка" value={s.sort} onChange={v => s.setSort(v as BigSort)} options={SORT_OPTIONS} className={PICK} />
      </Field>
      <Field label="Сумма сделки, ₽">
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <MoneyInput live value={posInt(s.smin)} onChange={v => s.setSmin(v ? String(v) : '')} placeholder="от" label="Сумма от" />
          <MoneyInput live value={posInt(s.smax)} onChange={v => s.setSmax(v ? String(v) : '')} placeholder="до" label="Сумма до" />
        </div>
      </Field>
      <Field label="Задача создана">
        <DateRange from={s.cfrom} to={s.cto} onFrom={s.setCfrom} onTo={s.setCto} />
      </Field>
      <Field label="Статус задачи">
        <SearchMultiSelect ariaLabel="Статус задачи" allLabel="Любой" unitLabel="статусов" searchPlaceholder="Поиск"
          options={STATE_OPTIONS} value={s.states} onChange={s.setStates} className={PICK} />
      </Field>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Сделка">
          <SearchSelect ariaLabel="Сделка" value={s.deal} onChange={s.setDeal} options={DEAL_OPTIONS} className={PICK} />
        </Field>
        <Field label="Не менялась, дней ≥">
          <DaysInput value={posInt(s.idle)} onChange={v => s.setIdle(v ? String(v) : '')} label="Не менялась дней" />
        </Field>
      </div>
      <div className="flex min-w-0 flex-col">
        <Check checked={s.stuck} onChange={s.setStuck}>Застряли — дольше нормы в колонке</Check>
        <Check checked={s.noCalls} onChange={s.setNoCalls}>Звонков после постановки не было</Check>
      </div>
      <div className="flex min-w-0 flex-wrap justify-between gap-2">
        {s.panelActive > 0 ? (
          <button type="button" onClick={s.resetPanel} className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">Сбросить фильтры</button>
        ) : <span />}
        {onDone && <button type="button" onClick={onDone} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm text-white">Готово</button>}
      </div>
    </div>
  );
}

/** Кнопка «Фильтры» с панелью. */
export function BigFiltersButton({ s }: { s: BigFilterState }) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const trigger = (
    <button type="button" onClick={isMobile ? () => setOpen(true) : undefined} className={s.panelActive ? BTN_ACTIVE : BTN_IDLE}
      aria-label="Фильтры" title="Сумма, дата создания, статус, сделка, застрявшие, без звонков, сортировка">
      <SlidersHorizontal size={16} aria-hidden /> <span>Фильтры</span>{s.panelActive ? <span className="tabular-nums">{s.panelActive}</span> : null}
    </button>
  );
  if (isMobile) {
    return (
      <>
        {trigger}
        <Modal open={open} onOpenChange={setOpen} title="Фильтры" desktopWidth="sm:max-w-md">
          <PanelBody s={s} onDone={() => setOpen(false)} />
        </Modal>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen} align="start" className="w-[380px] max-w-[calc(100vw-16px)] p-3" trigger={trigger}>
      <div className="max-h-[75dvh] overflow-y-auto overflow-x-hidden">
        <PanelBody s={s} />
      </div>
    </Popover>
  );
}

/** «Сбросить всё» — фильтры, проекты, менеджер, группы, поиск. */
export function ResetAllButton({ s, onReset }: { s: BigFilterState; onReset?: () => void }) {
  if (!s.anyActive) return null;
  return <button type="button" onClick={() => { s.resetAll(); onReset?.(); }} className={BTN_IDLE}><X size={14} aria-hidden />Сбросить</button>;
}
