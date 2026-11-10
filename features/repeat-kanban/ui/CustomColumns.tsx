'use client';
// «Свои колонки» во вкладке «Сегодня» (владелец 10.11; проект — Fable; миграция 262). РОП задаёт гипотезу набором
// условий — колонка показывает подходящих заказчиков, тревожных — сверху и красным, в заголовке — деньги и метрика
// «дошли до отгрузки за 30 дней: колонка против остальных». Условия — из тех же фильтров, что на доске, плюс LTV и
// «где заказчик сейчас». Личная по умолчанию, «Показать всем РОПам» — общая. Не больше 5 своих.
import { useEffect, useState } from 'react';
import { MoreHorizontal, Plus, SlidersHorizontal, Users } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { CLIENT_TYPE_ORDER, CLIENT_TYPE_SHORT, COLUMNS, SHIP_BUCKETS } from '../engine/config';
import type { TodaySection } from '../engine/board';
import type { CustomAlert, CustomFilters } from '../engine/customColumns';
import type { TagDef } from '../engine/tagColors';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace('.', ',')} млрд ₽` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} млн ₽` : n >= 1000 ? `${Math.round(n / 1000)} тыс. ₽` : `${rub.format(n)} ₽`);
const pct = (a: number, b: number) => (b ? `${String(Math.round((a / b) * 1000) / 10).replace('.', ',')}%` : '—');
const FIELD = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base text-[var(--color-text)] sm:text-sm';
const BTN_IDLE = 'inline-flex min-h-11 items-center justify-start gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]';

const TASKS = [
  { value: 'none', label: 'Без задачи' }, { value: 'unread', label: 'Не просмотрена' }, { value: 'work', label: 'В работе' },
  { value: 'overdue', label: 'Просрочена' }, { value: 'control', label: 'Ждёт приёмки' }, { value: 'done', label: 'Принята' },
];
const STAGES = [
  { value: 'g:pool', label: 'В пуле (любая колонка пула)' }, { value: 'g:touch', label: 'В дозвоне' },
  { value: 'g:stage', label: 'В воронке (рабочие стадии)' }, { value: 'g:review', label: 'На разборе / в браке' },
  ...COLUMNS.filter(c => c.group !== 'hidden').map(c => ({ value: c.key, label: c.title })),
];
const TYPES = [
  ...Object.keys(CLIENT_TYPE_ORDER).sort((a, b) => CLIENT_TYPE_ORDER[a] - CLIENT_TYPE_ORDER[b]).map(k => ({ value: k, label: CLIENT_TYPE_SHORT[k] })),
  { value: 'none', label: 'Тип не указан' },
];
const PRESETS: { label: string; name: string; f: CustomFilters; alert?: CustomAlert }[] = [
  { label: 'Крупные в работе', name: 'Крупные в работе', f: { ltvMin: 2_000_000, ships: ['2', '3', '4-5', '6-9', '10+'], stage: ['g:touch', 'g:stage'] }, alert: { noCallDays: 3, overdue: true } },
  { label: 'Золотые без сделки', name: 'Золотые без сделки', f: { ltvMin: 1_000_000, stage: ['g:pool'] } },
  { label: 'В воронке без задачи', name: 'В воронке без задачи', f: { stage: ['g:stage'], tasks: ['none'] } },
];

function Money({ value, onChange, placeholder, label }: { value: number | undefined; onChange: (v: number | undefined) => void; placeholder: string; label: string }) {
  const [draft, setDraft] = useState(value ? rub.format(value) : '');
  useEffect(() => { setDraft(value ? rub.format(value) : ''); }, [value]);
  return (
    <input value={draft} inputMode="numeric" placeholder={placeholder} aria-label={label}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { const d = Number(draft.replace(/\D/g, '').slice(0, 12)); onChange(d > 0 ? d : undefined); }}
      className={`${FIELD} tabular-nums`} />
  );
}
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex min-w-0 flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">{label}{children}</label>
);

export interface ColumnDraft { id?: number; name: string; shared: boolean; filters: CustomFilters; alert: CustomAlert | null }

export function CustomColumnModal({ initial, tagDefs, scopeQs, onClose, onSaved }: {
  initial: ColumnDraft | null; tagDefs: TagDef[]; scopeQs: string; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [f, setF] = useState<CustomFilters>(initial?.filters ?? {});
  const [alert, setAlert] = useState<CustomAlert>(initial?.alert ?? {});
  const [shared, setShared] = useState(initial?.shared ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ total: number; ltv: number } | null>(null);
  const set = (patch: Partial<CustomFilters>) => setF(prev => {
    const n = { ...prev, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(n)) if (n[k] === undefined || (Array.isArray(n[k]) && !(n[k] as unknown[]).length)) delete n[k];
    return n as CustomFilters;
  });
  const empty = !Object.keys(f).length;
  // Живой предпросмотр (Fable: «без него РОП сохраняет вслепую»): сколько подходит сейчас в зоне доски.
  useEffect(() => {
    if (empty) { setPreview(null); return; }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/repeat-kanban?${scopeQs}${scopeQs ? '&' : ''}colPreview=${encodeURIComponent(JSON.stringify(f))}`).catch(() => null);
      const j = r ? await r.json().catch(() => null) : null;
      setPreview(j?.preview ?? null);
    }, 700);
    return () => clearTimeout(t);
  }, [f, empty, scopeQs]);
  const filtersChanged = !!initial?.id && JSON.stringify(f) !== JSON.stringify(initial.filters);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { id: initial?.id, name, shared, filters: f, alert: Object.keys(alert).length ? alert : null };
      const r = await fetch('/api/repeat-kanban/today-columns', { method: initial?.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      onSaved(); onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={initial?.id ? 'Своя колонка' : 'Новая колонка в «Сегодня»'} desktopWidth="sm:max-w-lg">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <Field label="Название"><input value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="Крупные в работе" className={FIELD} /></Field>
        {!initial?.id && (
          <div className="flex flex-wrap gap-1.5">
            <span className="w-full text-[12px] text-[var(--color-text-muted)]">Заготовки — заполнят условия ниже:</span>
            {PRESETS.map(p => (
              <button key={p.label} type="button" onClick={() => { setF(p.f); setAlert(p.alert ?? {}); if (!name.trim()) setName(p.name); }}
                className="min-h-9 rounded-full border border-[var(--color-border)] px-3 text-[12.5px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">{p.label}</button>
            ))}
          </div>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="LTV от"><Money value={f.ltvMin} onChange={v => set({ ltvMin: v })} placeholder="2 000 000" label="LTV от" /></Field>
          <Field label="LTV до"><Money value={f.ltvMax} onChange={v => set({ ltvMax: v })} placeholder="без границы" label="LTV до" /></Field>
        </div>
        <Field label="Количество отгрузок">
          <SearchMultiSelect ariaLabel="Количество отгрузок" allLabel="Сколько угодно" unitLabel="вариантов" searchPlaceholder="Поиск"
            options={SHIP_BUCKETS.map(b => ({ value: b.value, label: b.label }))} value={f.ships ?? []} onChange={v => set({ ships: v })} className={`${BTN_IDLE} w-full`} />
        </Field>
        <Field label="Где заказчик сейчас">
          <SearchMultiSelect ariaLabel="Где заказчик сейчас" allLabel="Где угодно" unitLabel="колонок" searchPlaceholder="Колонка доски"
            options={STAGES} value={f.stage ?? []} onChange={v => set({ stage: v })} className={`${BTN_IDLE} w-full`} />
        </Field>
        <Field label="Задачи">
          <SearchMultiSelect ariaLabel="Задачи" allLabel="Любые" unitLabel="состояний" searchPlaceholder="Поиск"
            options={TASKS} value={f.tasks ?? []} onChange={v => set({ tasks: v as CustomFilters['tasks'] })} className={`${BTN_IDLE} w-full`} />
        </Field>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Тип клиента">
            <SearchMultiSelect ariaLabel="Тип клиента" allLabel="Любой" unitLabel="типов" searchPlaceholder="Поиск"
              options={TYPES} value={f.type ?? []} onChange={v => set({ type: v })} className={`${BTN_IDLE} w-full`} />
          </Field>
          <Field label="Последняя сделка">
            <SearchSelect ariaLabel="Последняя сделка" value={f.outcome ?? ''} onChange={v => set({ outcome: v === 'won' || v === 'lost' ? v : undefined })}
              options={[{ value: '', label: 'Любая' }, { value: 'won', label: 'Успешная' }, { value: 'lost', label: 'Проигранная' }]} className={`${BTN_IDLE} w-full`} />
          </Field>
        </div>
        {tagDefs.length > 0 && (
          <Field label={shared ? 'Теги (в общей колонке — только базовые)' : 'Теги'}>
            <SearchMultiSelect ariaLabel="Теги" allLabel="Любые" unitLabel="тегов" searchPlaceholder="Поиск тега"
              options={tagDefs.filter(t => !shared || t.system).map(t => ({ value: String(t.id), label: t.name }))}
              value={(f.tags ?? []).map(String)} onChange={v => set({ tags: v.map(Number) })} className={`${BTN_IDLE} w-full`} />
          </Field>
        )}
        <div className="rounded-lg bg-[var(--color-bg-surface)] px-3 py-2 text-[13px]">
          {empty ? <span className="text-[var(--color-text-muted)]">Задайте хотя бы одно условие.</span>
            : preview ? <>Подходит сейчас: <b>{rub.format(preview.total)}</b> {preview.total === 1 ? 'заказчик' : 'заказчиков'}{preview.ltv ? <> · LTV {money(preview.ltv)}</> : null}</>
              : <span className="text-[var(--color-text-muted)]">Считаю…</span>}
        </div>
        <fieldset className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2">
          <legend className="px-1 text-[13px] text-[var(--color-text-secondary)]">Что считать проблемой (тревожные — сверху и красным)</legend>
          <label className="flex min-h-11 flex-wrap items-center gap-2">
            <input type="checkbox" checked={!!alert.noCallDays} onChange={e => setAlert(a => ({ ...a, noCallDays: e.target.checked ? 3 : undefined }))} className="h-4 w-4" />
            Нет звонка
            <input type="number" min={1} max={90} value={alert.noCallDays ?? 3} disabled={!alert.noCallDays} aria-label="Дней без звонка"
              onChange={e => setAlert(a => ({ ...a, noCallDays: Math.max(1, Math.min(90, Number(e.target.value) || 1)) }))}
              className="min-h-9 w-16 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-base sm:text-sm" />
            дней <span className="w-full text-[11.5px] text-[var(--color-text-muted)]">только у заказчиков со сделкой (у пула звонков в карточке нет)</span>
          </label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={!!alert.overdue} onChange={e => setAlert(a => ({ ...a, overdue: e.target.checked || undefined }))} className="h-4 w-4" />Задача просрочена</label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={!!alert.noTask} onChange={e => setAlert(a => ({ ...a, noTask: e.target.checked || undefined }))} className="h-4 w-4" />Нет задачи</label>
        </fieldset>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} className="h-4 w-4" />Показать всем РОПам</label>
        {filtersChanged && <p className="text-[12px] text-[#b45f06]">Условия изменились — метрика «дошли до отгрузки» начнёт копиться заново.</p>}
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || empty || name.trim().length < 2} onClick={save}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'Сохранить'}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Заголовок своей колонки: название, «общая», счётчик, «⋯»; деньги; тревога и метрика гипотезы. */
export function CustomHeader({ sec, onEdit, onChanged, hidden }: { sec: TodaySection; onEdit: () => void; onChanged: () => void; hidden: number[] }) {
  const c = sec.custom!;
  const [open, setOpen] = useState(false);
  const m = c.metric;
  const act = async (what: 'share' | 'delete' | 'hide' | 'copy') => {
    setOpen(false);
    if (what === 'delete') {
      if (!confirm(`Удалить колонку «${sec.title}»?`)) return;
      await fetch(`/api/repeat-kanban/today-columns?id=${c.id}`, { method: 'DELETE' });
    } else if (what === 'share') {
      await fetch('/api/repeat-kanban/today-columns', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id, shared: !c.shared }) });
    } else if (what === 'hide') {
      await fetch('/api/me/ui-prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenTodayColumns: [...new Set([...hidden, c.id])] }) });
    } else {
      const r = await fetch('/api/repeat-kanban/today-columns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sec.title, filters: c.filters, alert: c.alert, shared: false }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error ?? 'Не удалось скопировать'); }
    }
    onChanged();
  };
  // Пример: править может РОП и выше (свои колонки видит только РОП), удалить нельзя; можно скопировать или скрыть.
  const items = c.example
    ? [{ k: 'edit', l: 'Изменить условия примера' }, { k: 'copy', l: 'Скопировать себе' }, { k: 'hide', l: 'Скрыть у себя' }]
    : c.own
      ? [{ k: 'edit', l: 'Изменить условия' }, { k: 'share', l: c.shared ? 'Сделать личной' : 'Показать всем РОПам' }, { k: 'delete', l: 'Удалить', danger: true }]
      : [{ k: 'copy', l: 'Скопировать себе' }, { k: 'hide', l: 'Скрыть у себя' }];
  const metricText = !m ? null : !m.ready ? `копим данные · ${m.days} дн., ${m.inN} в колонке` : `отгрузка за 30 дн.: ${pct(m.inShipped, m.inN)} против ${pct(m.restShipped, m.restN)}`;
  const metricTitle = m ? `Дошли до отгрузки за 30 дней: в колонке ${m.inShipped} из ${m.inN}, остальные заказчики доски ${m.restShipped} из ${m.restN}. Сравнение, не доказательство. Колонке ${m.days} дн.${!m.ready ? ' Считаем, когда ей 7+ дней и в ней 20+ заказчиков.' : ''}` : undefined;
  return (
    // Пунктир вместо сплошной полосы (Fable): рифмуется с плиткой «+ Своя колонка», не путается со стандартными.
    <div className="rounded-lg border border-dashed border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[var(--color-bg)] px-2 py-1.5" title={sec.hint}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-1 text-sm font-semibold text-[var(--color-text)]">
          <SlidersHorizontal size={13} className="shrink-0 text-[var(--color-accent)]" />
          <span className="truncate">{sec.title}</span>
          {c.example && <span title="Колонка-пример: видят все, условия меняет РОП и выше" className="shrink-0 rounded border border-[var(--color-border)] px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">пример</span>}
          {c.shared && !c.example && <span title={c.own ? 'Общая: видят все РОПы' : `Общая колонка · ${c.ownerName ?? 'РОП'}`}><Users size={13} className="shrink-0 text-[var(--color-text-muted)]" /></span>}
        </h2>
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{rub.format(sec.total)}</span>
          <Popover open={open} onOpenChange={setOpen} align="end" className="w-52 p-1" trigger={
            <button type="button" aria-label="Действия с колонкой" className="tap-target inline-flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><MoreHorizontal size={16} /></button>
          }>
            {items.map(i => (
              <button key={i.k} type="button" onClick={() => (i.k === 'edit' ? (setOpen(false), onEdit()) : act(i.k as 'share' | 'delete' | 'hide' | 'copy'))}
                className={`flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)] ${'danger' in i && i.danger ? 'text-[#990000]' : 'text-[var(--color-text)]'}`}>{i.l}</button>
            ))}
          </Popover>
        </span>
      </div>
      <div className="text-xs text-[var(--color-text-muted)]">LTV {money(c.ltv)}{c.dealSum ? ` · в сделках ${money(c.dealSum)}` : ''}{c.own || c.example ? '' : ` · ${c.ownerName ?? 'РОП'}`}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {c.alertCount > 0 && <span className="rounded bg-[#f4cccc] px-1.5 text-[11px] font-bold text-[#990000]">тревога: {c.alertCount}</span>}
        {metricText && <span className="rounded bg-[var(--color-bg)] px-1.5 text-[11px] text-[var(--color-text-secondary)]" title={metricTitle}>{metricText}</span>}
      </div>
    </div>
  );
}

export function AddColumnTile({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={disabled ? 'Не больше 5 своих колонок' : 'Своя колонка: заказчики по вашим условиям'}
      className="flex h-full min-h-40 w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50 sm:w-40">
      <Plus size={18} /> Своя колонка
    </button>
  );
}
