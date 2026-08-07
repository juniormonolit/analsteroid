'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Filter, Plus, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { DealFilter, DealFilterOp } from '@/lib/metrics/dealFilters';

// «Фильтр сделок» (задача владельца 07.08.2026). Кнопка в ряду тулбара рядом со
// «Сравнением» и «Создать группу» (тот же стиль, что CreateGroupButton) плюс
// окно с условиями.
//
// Зачем отдельно от фильтров метрики: условия здесь режут САМ НАБОР СДЕЛОК всего
// отчёта — и числитель, и знаменатель конверсий одинаково. Юзкейс владельца:
// «конверсия по утеплителю 15 %, гипотеза — из-за мелких чеков; строю отчёт
// только из сделок с чеком выше 50, 70 тыс и смотрю, меняется ли конверсия».
//
// Список полей и операторов НЕ хардкодится здесь: он приходит из
// /api/reports/deal-filter-options, который отдаёт его из
// lib/metrics/dealFilters.ts — там же, где живёт разбор в SQL. Один источник
// правды: новое поле появляется в пикере само, и невозможна ситуация «UI
// предлагает оператор, который сервер не умеет».

interface FieldDef {
  key: string;
  label: string;
  kind: 'number' | 'int' | 'date' | 'text' | 'enum';
  options: string | null;
  ops: DealFilterOp[];
}
interface OptionsResponse {
  fields: FieldDef[];
  options: Record<string, { value: string; label: string }[]>;
}

// Подписи операторов — символами, а не словами: на 375px нативный <select>
// обрезал «больше или равно» прямо по букве (проверено на превью), а знак
// читается мгновенно и не зависит от ширины.
const OP_LABEL: Record<DealFilterOp, string> = {
  eq: '= равно', neq: '≠ не равно', in: 'одно из', not_in: 'кроме',
  gt: '> больше', gte: '≥ больше или равно', lt: '< меньше', lte: '≤ меньше или равно',
  between: 'между', is_null: 'не заполнено', is_not_null: 'заполнено',
};

export function useDealFilterOptions() {
  return useQuery<OptionsResponse>({
    queryKey: ['deal-filter-options'],
    queryFn: async () => {
      const res = await fetch('/api/reports/deal-filter-options');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function DealFilterButton({ value, onChange }: {
  value: DealFilter[];
  onChange: (next: DealFilter[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = value.length > 0;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Ограничить отчёт определёнными сделками — например, только с чеком выше 50 000 ₽"
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-lg transition-colors ${
          active
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
            : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
        }`}
      >
        <Filter size={12} /> Фильтр сделок
        {active && (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold text-white tabular-nums">
            {value.length}
          </span>
        )}
      </button>
      {open && <DealFilterModal value={value} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}

function DealFilterModal({ value, onChange, onClose }: {
  value: DealFilter[];
  onChange: (next: DealFilter[]) => void;
  onClose: () => void;
}) {
  const { data, isLoading } = useDealFilterOptions();
  // Черновик: правки применяются кнопкой, а не на каждый чих — иначе отчёт
  // пересчитывался бы на каждое нажатие клавиши в поле суммы.
  const [draft, setDraft] = useState<DealFilter[]>(value);
  useEffect(() => { setDraft(value); }, [value]);

  const fields = data?.fields ?? [];
  const upd = (i: number, patch: Partial<DealFilter>) =>
    setDraft(d => d.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  function addRow() {
    const f = fields[0];
    if (!f) return;
    setDraft(d => [...d, { field: f.key, op: f.ops[0], value: '' }]);
  }
  function changeField(i: number, key: string) {
    const def = fields.find(f => f.key === key);
    if (!def) return;
    // Смена поля сбрасывает оператор и значение: у суммы операторы сравнения, у
    // воронки — списки, старая пара «оператор+значение» почти всегда невалидна.
    upd(i, { field: key, op: def.ops[0], value: def.ops[0] === 'between' ? ['', ''] : '' });
  }

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title="Фильтр сделок" desktopWidth="sm:max-w-2xl">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-[var(--color-text-muted)]">
          Условия режут набор сделок, из которых считается ВЕСЬ отчёт — включая обе части конверсий.
          Например «Сумма сделки ≥ 50 000» покажет конверсию только по крупным сделкам.
        </p>

        {isLoading && <div className="text-xs text-[var(--color-text-muted)]">Загрузка полей…</div>}

        {draft.map((f, i) => {
          const def = fields.find(x => x.key === f.field);
          const opts = def?.options ? data?.options[def.options] ?? [] : [];
          const needsValue = f.op !== 'is_null' && f.op !== 'is_not_null';
          return (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--color-border)] p-2">
              <label className="flex min-w-[140px] flex-1 flex-col gap-1">
                <span className="text-[11px] text-[var(--color-text-muted)]">Поле</span>
                <select value={f.field} onChange={e => changeField(i, e.target.value)}
                  className="min-h-11 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-sm">
                  {fields.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
              </label>
              <label className="flex w-[150px] flex-col gap-1">
                <span className="text-[11px] text-[var(--color-text-muted)]">Условие</span>
                <select value={f.op}
                  onChange={e => {
                    const op = e.target.value as DealFilterOp;
                    upd(i, { op, value: op === 'between' ? ['', ''] : Array.isArray(f.value) ? '' : f.value });
                  }}
                  className="min-h-11 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-sm">
                  {(def?.ops ?? []).map(op => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
                </select>
              </label>
              {needsValue && (
                <label className="flex min-w-[160px] flex-1 flex-col gap-1">
                  <span className="text-[11px] text-[var(--color-text-muted)]">Значение</span>
                  <ValueInput def={def} filter={f} opts={opts} onChange={v => upd(i, { value: v })} />
                </label>
              )}
              <button type="button" onClick={() => setDraft(d => d.filter((_, j) => j !== i))}
                title="Убрать условие"
                className="tap-target rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-negative)]">
                <X size={14} />
              </button>
            </div>
          );
        })}

        <button type="button" onClick={addRow} disabled={fields.length === 0}
          className="min-h-11 flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 text-xs hover:bg-[var(--color-bg-hover)] disabled:opacity-40">
          <Plus size={12} /> Добавить условие
        </button>

        {/* Честное предупреждение: план приходит НЕ из сделок (sales_plans), и
            отфильтровать его невозможно. Молча показать «выполнение плана 300 %»
            на порезанном факте — худшее, что тут можно сделать. */}
        {draft.length > 0 && (
          <p className="rounded-lg border border-[var(--color-warning,#e8590c)]/40 bg-[var(--color-warning,#e8590c)]/10 px-3 py-2 text-[11px] text-[var(--color-text)]">
            План-метрики («Выполнение плана…») фильтр не режет: план задаётся людям целиком, а не по сделкам.
            При активном фильтре факт будет урезан, а план — нет, поэтому проценты выполнения смотреть нельзя.
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {value.length > 0 && (
            <button type="button" onClick={() => { onChange([]); onClose(); }}
              className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)]">
              Сбросить фильтр
            </button>
          )}
          <button type="button" onClick={onClose}
            className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)]">
            Отмена
          </button>
          <button type="button"
            onClick={() => { onChange(draft.filter(f => f.field)); onClose(); }}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-xs font-semibold text-[var(--color-text-inverse)]">
            Применить
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ValueInput({ def, filter, opts, onChange }: {
  def: FieldDef | undefined;
  filter: DealFilter;
  opts: { value: string; label: string }[];
  onChange: (v: DealFilter['value']) => void;
}) {
  const cls = 'min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-sm';
  if (!def) return null;

  if (filter.op === 'between') {
    const arr = Array.isArray(filter.value) ? filter.value : ['', ''];
    return (
      <span className="flex items-center gap-1.5">
        <input className={cls} inputMode={def.kind === 'date' ? undefined : 'decimal'}
          type={def.kind === 'date' ? 'date' : 'text'} value={String(arr[0] ?? '')}
          onChange={e => onChange([e.target.value, arr[1] ?? ''])} placeholder="от" />
        <input className={cls} inputMode={def.kind === 'date' ? undefined : 'decimal'}
          type={def.kind === 'date' ? 'date' : 'text'} value={String(arr[1] ?? '')}
          onChange={e => onChange([arr[0] ?? '', e.target.value])} placeholder="до" />
      </span>
    );
  }

  // Справочные поля — мультивыбор для in/not_in, одиночный для eq/neq. Тег
  // <select multiple> вместо самописного дропдауна: на телефоне iOS/Android
  // показывают его родным листом выбора, и правило 4 CLAUDE.md (никакого
  // ручного позиционирования поповеров) соблюдается само собой.
  if (opts.length > 0) {
    const multi = filter.op === 'in' || filter.op === 'not_in';
    const selected = Array.isArray(filter.value) ? filter.value.map(String) : [String(filter.value ?? '')];
    return (
      <select className={`${cls} ${multi ? 'min-h-[88px] py-1' : ''}`} multiple={multi}
        value={multi ? selected : selected[0] ?? ''}
        onChange={e => onChange(multi
          ? [...e.target.selectedOptions].map(o => o.value)
          : e.target.value)}>
        {!multi && <option value="">— выберите —</option>}
        {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }

  return (
    <input className={cls} type={def.kind === 'date' ? 'date' : 'text'}
      inputMode={def.kind === 'number' || def.kind === 'int' ? 'decimal' : undefined}
      value={Array.isArray(filter.value) ? '' : String(filter.value ?? '')}
      onChange={e => onChange(e.target.value)}
      placeholder={def.kind === 'number' ? '50000' : ''} />
  );
}
