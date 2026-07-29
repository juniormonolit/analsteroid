'use client';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { ChevronDown, ChevronRight, Building2, ArrowLeftRight, Search, X, SlidersHorizontal, Layers } from 'lucide-react';
import type { DateRange } from '@/lib/period';
import type { Grouping } from '@/lib/metrics/types';
import { SOURCE_DIMENSIONS, type SourceDimension } from '@/lib/marketing/dimensions';
import { recomputeComparison, calendarComparisonForPreset } from '@/lib/period';
import { Popover } from '@/components/ui/Popover';
import { DateRangePicker, type PeriodChangeMeta } from './DateRangePicker';

const GROUPING_LABELS: Record<Grouping, string> = { none: 'Без групп.', team: 'По отделу', branch: 'По филиалу', total: 'Итого' };

interface DeptNode {
  id: string;
  name: string;
  bitrixId: string;
  children?: DeptNode[];
}

// Экспортируется как FilterBarProps (задача 1714, мобильный тулбар) — MobileReportBar
// компонует те же поля через переиспользуемые куски (MainPeriodControl,
// ComparisonPeriodControl, MetricsButton, SearchField, GroupingSelector,
// SourceDimensionSelector) в выдвижной панели, без второй копии состояния/типов.
export interface FilterBarProps {
  period: DateRange;
  comparison: DateRange;
  departmentIds: string[];
  search?: string;
  grouping?: Grouping;
  onPeriodChange: (p: DateRange) => void;
  onComparisonChange: (p: DateRange) => void;
  onDepartmentIdsChange: (ids: string[]) => void;
  onSearchChange?: (v: string) => void;
  onGroupingChange?: (g: Grouping) => void;
  onOpenMetricPanel?: () => void;
  metricsBadge?: number;
  showDepartments?: boolean; // false = скрыть выбор отделов (маркетинг)
  // Маркетинг: селектор главной сущности (вместо «Группировки»)
  sourceDimension?: SourceDimension;
  onSourceDimensionChange?: (d: SourceDimension) => void;
}
type Props = FilterBarProps;

function fmt(d: Date) {
  return format(d, 'dd.MM.yyyy', { locale: ru });
}

function allIds(node: DeptNode): string[] {
  return [node.bitrixId, ...(node.children ?? []).flatMap(allIds)];
}

// Общее число отделов в оргструктуре (все узлы дерева, включая промежуточные группы —
// та же единица счёта, что и у deptLabel/departmentIds ниже). Используется в диагноз-
// пилюле составного empty state отчёта (задача 1698, кейс 10Б) — там нужно показать
// «Отделы: все (N)», а не просто «выбрано M», поэтому SalesReportPage тоже подписывается
// на тот же React Query кэш ['org-structure'] и считает total этой функцией.
export function countAllDepartmentIds(tree: DeptNode[]): number {
  const ids = new Set<string>();
  tree.forEach(node => allIds(node).forEach(id => ids.add(id)));
  return ids.size;
}

type CheckState = 'none' | 'some' | 'all';

function getCheckState(node: DeptNode, selected: Set<string>): CheckState {
  const ids = allIds(node);
  const count = ids.filter(id => selected.has(id)).length;
  if (count === 0) return 'none';
  if (count === ids.length) return 'all';
  return 'some';
}

function DeptCheckbox({ state, onChange }: { state: CheckState; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      onChange={onChange}
      className="accent-[var(--color-accent)] w-3.5 h-3.5 flex-shrink-0 cursor-pointer"
    />
  );
}

function DeptTreeNode({
  node, selected, onToggle, depth = 0,
}: {
  node: DeptNode; selected: Set<string>;
  onToggle: (ids: string[], forceOn?: boolean) => void;
  depth?: number;
}) {
  const hasChildren = (node.children ?? []).length > 0;
  const [expanded, setExpanded] = useState(false); // collapsed to first level by default
  const state = getCheckState(node, selected);

  function handleCheck() { onToggle(allIds(node), state !== 'all'); }

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1.5 hover:bg-[var(--color-bg-hover)] cursor-pointer select-none"
        style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: '8px' }}
      >
        <button
          className="flex-shrink-0 text-[var(--color-text-muted)] w-4 h-4 flex items-center justify-center"
          onClick={e => { e.stopPropagation(); if (hasChildren) setExpanded(v => !v); }}
        >
          {hasChildren
            ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
            : <span className="w-3" />
          }
        </button>
        <DeptCheckbox state={state} onChange={handleCheck} />
        <span
          className={`text-sm truncate flex-1 ${depth === 0 ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}
          onClick={handleCheck}
        >
          {node.name}
        </span>
      </div>
      {hasChildren && expanded && (
        <div>
          {node.children!.map(child => (
            <DeptTreeNode key={child.id} node={child} selected={selected} onToggle={onToggle} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Период + период сравнения — общий переиспользуемый блок ─────────────────
// Вынесен из FilterBar, чтобы дрилл-даун (DrilldownDrawer) мог встроить тот же
// контрол со своим (независимым от основного отчёта) состоянием периода.
//
// Семантика сравнения при смене ГЛАВНОГО периода (задача 10.07, дословно
// владельца: «При выборе периода быстрыми кнопками типа "прошлый месяц"
// сравнительный должен не хвостик подгружать, а тоже месяц»):
//  - клик по кнопке БЫСТРОГО ПРЕСЕТА (DateRangePicker передаёт meta.presetKey) →
//    сравнение = ТОТ ЖЕ календарный объект на шаг назад (calendarComparisonForPreset);
//  - ручной выбор двух дней в календаре (meta отсутствует) → сравнение = хвост той
//    же длины, как раньше — `manualComparisonFn` (дефолт recomputeComparison,
//    поведение основного отчёта; карточка менеджера передаёт previousPeriodSameLength,
//    сохраняя СВОЙ прежний дефолт «период сразу перед текущим»).
// ── Основной период — вынесен отдельно от периода сравнения (задача 1714, мобильный
// тулбар): снаружи над таблицей на мобиле остаётся ТОЛЬКО этот компактный пикер,
// период сравнения переезжает в панель «Фильтры» (см. ComparisonPeriodControl ниже).
// На десктопе PeriodRangeControls по-прежнему рендерит оба вместе — вывод идентичен
// прежнему (просто собран из двух кусков вместо одного блока JSX).
export function MainPeriodControl({ period, onPeriodChange, onComparisonChange, manualComparisonFn = recomputeComparison, compact = false }: {
  period: DateRange;
  onPeriodChange: (p: DateRange) => void; onComparisonChange: (p: DateRange) => void;
  manualComparisonFn?: (p: DateRange) => DateRange;
  // compact — мобильная кнопка снаружи панели: короче дата (без года, «7 июл – 11 июл»)
  // и меньше паддинг/шрифт, иначе не помещается рядом с кнопкой «Фильтры» на 375px.
  compact?: boolean;
}) {
  const [showPeriod, setShowPeriod] = useState(false);

  function handlePeriodChange(p: DateRange, meta?: PeriodChangeMeta) {
    onPeriodChange(p);
    onComparisonChange(meta?.presetKey ? calendarComparisonForPreset(meta.presetKey) : manualComparisonFn(p));
    setShowPeriod(false);
  }

  return (
    <Popover
      open={showPeriod}
      onOpenChange={setShowPeriod}
      className="rounded-xl"
      trigger={
        <button
          className={`flex items-center border rounded-lg transition-colors ${
            compact ? 'gap-1 px-2.5 py-1.5 text-xs' : 'gap-2 px-3 py-1.5 text-sm'
          } ${
            showPeriod
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] hover:border-[var(--color-border-focus)] text-[var(--color-text)]'
          }`}
        >
          <span className={`tabular-nums ${compact ? 'whitespace-nowrap' : ''}`}>
            {compact
              ? `${format(period.from, 'd MMM', { locale: ru })} – ${format(period.to, 'd MMM', { locale: ru })}`
              : `${fmt(period.from)} — ${fmt(period.to)}`}
          </span>
          <ChevronDown size={compact ? 12 : 14} className="text-[var(--color-text-muted)]" />
        </button>
      }
    >
      <DateRangePicker
        value={period}
        onChange={handlePeriodChange}
        onClose={() => setShowPeriod(false)}
        showPresets
      />
    </Popover>
  );
}

// ── Период сравнения — самостоятельный кусок (задача 1714): на десктопе живёт рядом
// с MainPeriodControl (см. PeriodRangeControls), на мобиле переезжает внутрь панели
// «Фильтры» (MobileReportBar), тот же компонент — без второй копии Popover/состояния.
export function ComparisonPeriodControl({ comparison, onComparisonChange }: {
  comparison: DateRange; onComparisonChange: (p: DateRange) => void;
}) {
  const [showComp, setShowComp] = useState(false);
  return (
    <Popover
      open={showComp}
      onOpenChange={setShowComp}
      className="rounded-xl"
      trigger={
        <button
          className={`flex items-center gap-1.5 px-2.5 py-1.5 border rounded-lg text-sm transition-colors ${
            showComp
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-focus)] hover:text-[var(--color-text)]'
          }`}
        >
          <ArrowLeftRight size={13} className="shrink-0" />
          <span className="tabular-nums">{fmt(comparison.from)} — {fmt(comparison.to)}</span>
          <ChevronDown size={13} className="text-[var(--color-text-muted)]" />
        </button>
      }
    >
      <DateRangePicker
        value={comparison}
        onChange={p => { onComparisonChange(p); setShowComp(false); }}
        onClose={() => setShowComp(false)}
        showPresets={false}
        title="Период сравнения"
      />
    </Popover>
  );
}

// ── Период + период сравнения вместе — используется там, где оба живут рядом в одной
// строке (десктоп FilterBar, ManagerCardPanel, DrilldownDrawer): просто композиция двух
// кусков выше, поведение и разметка не изменились относительно прежней версии.
export function PeriodRangeControls({ period, comparison, onPeriodChange, onComparisonChange, manualComparisonFn = recomputeComparison }: {
  period: DateRange; comparison: DateRange;
  onPeriodChange: (p: DateRange) => void; onComparisonChange: (p: DateRange) => void;
  manualComparisonFn?: (p: DateRange) => DateRange;
}) {
  return (
    <>
      <MainPeriodControl
        period={period}
        onPeriodChange={onPeriodChange}
        onComparisonChange={onComparisonChange}
        manualComparisonFn={manualComparisonFn}
      />
      <ComparisonPeriodControl comparison={comparison} onComparisonChange={onComparisonChange} />
    </>
  );
}

// ── Выбор отделов — общий переиспользуемый блок (дерево орг. структуры) ─────
// Тоже вынесен наружу, чтобы дрилл-даун мог встроить тот же контрол со своим
// независимым набором отделов.
export function DepartmentPicker({ departmentIds, onDepartmentIdsChange }: {
  departmentIds: string[]; onDepartmentIdsChange: (ids: string[]) => void;
}) {
  const [showDepts, setShowDepts] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(departmentIds));

  const { data: orgData } = useQuery({
    queryKey: ['org-structure'],
    queryFn: () => fetch('/api/catalog/org-structure').then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const tree: DeptNode[] = orgData?.tree ?? [];

  function applyDepts()  { onDepartmentIdsChange(Array.from(draft)); setShowDepts(false); }
  function cancelDepts() { setDraft(new Set(departmentIds)); setShowDepts(false); }

  function toggleIds(ids: string[], forceOn?: boolean) {
    setDraft(prev => {
      const next = new Set(prev);
      if (forceOn === true)       ids.forEach(id => next.add(id));
      else if (forceOn === false) ids.forEach(id => next.delete(id));
      else {
        const allSelected = ids.every(id => next.has(id));
        if (allSelected) ids.forEach(id => next.delete(id));
        else ids.forEach(id => next.add(id));
      }
      return next;
    });
  }

  const deptLabel = departmentIds.length === 0 ? 'Все отделы' : `${departmentIds.length} отд.`;

  return (
    <Popover
      open={showDepts}
      onOpenChange={(o) => {
        if (o) setDraft(new Set(departmentIds)); // свежий драфт при каждом открытии
        setShowDepts(o);
      }}
      align="end"
      className="w-[280px] flex flex-col overflow-hidden"
      trigger={
        <button
          className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-colors ${
            departmentIds.length > 0
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] hover:border-[var(--color-border-focus)] text-[var(--color-text)]'
          }`}
        >
          <Building2 size={14} />
          <span>{deptLabel}</span>
          <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
        </button>
      }
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] flex-shrink-0">
        <span className="text-sm font-medium text-[var(--color-text)]">Отделы</span>
        {draft.size > 0 && (
          <button onClick={() => setDraft(new Set())} className="text-xs text-[var(--color-accent)] hover:underline">Очистить</button>
        )}
      </div>
      <div className="overflow-y-auto flex-1 py-1 max-h-[300px]">
        {tree.map(node => (
          <DeptTreeNode key={node.id} node={node} selected={draft} onToggle={toggleIds} depth={0} />
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[var(--color-border)] flex-shrink-0">
        <button onClick={cancelDepts} className="px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">Отмена</button>
        <button onClick={applyDepts} className="px-4 py-1.5 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity">Применить</button>
      </div>
    </Popover>
  );
}

// ── Выбор товарных групп — мультиселект с поиском (раздел «Графики», задача
// 29.07). Визуальный язык и поведение (Popover-панель, кнопка «Очистить»,
// «Отмена»/«Применить» с драфтом, применяется только по клику) — ТЕ ЖЕ, что у
// DepartmentPicker выше: список плоский (а не дерево — товарные группы не
// иерархичны), с полем поиска — в шкале kc ~96 групп, без поиска непригодно для
// использования. options приходят от вызывающего компонента (зависят от
// выбранной шкалы kc/by_max — см. /api/catalog/product-groups?mode=).
export interface ProductGroupOption { id: string; name: string }

export function ProductGroupPicker({ productGroupIds, onProductGroupIdsChange, options, loading = false }: {
  productGroupIds: string[]; onProductGroupIdsChange: (ids: string[]) => void;
  options: ProductGroupOption[]; loading?: boolean;
}) {
  const [showGroups, setShowGroups] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(productGroupIds));
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? options.filter(o => o.name.toLowerCase().includes(q)) : options;
  }, [options, search]);

  function applyGroups() { onProductGroupIdsChange(Array.from(draft)); setShowGroups(false); }
  function cancelGroups() { setDraft(new Set(productGroupIds)); setShowGroups(false); }
  function toggle(id: string) {
    setDraft(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const groupsLabel = productGroupIds.length === 0 ? 'Все группы' : `${productGroupIds.length} гр.`;

  return (
    <Popover
      open={showGroups}
      onOpenChange={(o) => {
        if (o) { setDraft(new Set(productGroupIds)); setSearch(''); } // свежий драфт при каждом открытии
        setShowGroups(o);
      }}
      align="end"
      className="w-[300px] max-w-[calc(100vw-16px)] flex flex-col overflow-hidden"
      trigger={
        <button
          className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-colors min-h-[38px] ${
            productGroupIds.length > 0
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] hover:border-[var(--color-border-focus)] text-[var(--color-text)]'
          }`}
        >
          <Layers size={14} />
          <span>{groupsLabel}</span>
          <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
        </button>
      }
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] flex-shrink-0">
        <span className="text-sm font-medium text-[var(--color-text)]">Товарные группы</span>
        {draft.size > 0 && (
          <button onClick={() => setDraft(new Set())} className="text-xs text-[var(--color-accent)] hover:underline">Очистить</button>
        )}
      </div>
      <div className="p-2 border-b border-[var(--color-border)] flex-shrink-0">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск группы…"
          // text-base на мобиле — предотвращает авто-зум iOS Safari на фокусе поля
          className="w-full text-base sm:text-sm border border-[var(--color-border)] rounded-md px-2 py-1.5 bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>
      <div className="overflow-y-auto flex-1 py-1 max-h-[320px]">
        {loading ? (
          <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">Загрузка…</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">Ничего не найдено</div>
        ) : filtered.map(o => {
          const checked = draft.has(o.id);
          return (
            // min-h-[44px] — тап-цель ≥44px (мобильная проверка брифа задачи 29.07)
            <label
              key={o.id}
              className="flex items-center gap-2 px-3 py-2.5 min-h-[44px] hover:bg-[var(--color-bg-hover)] cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(o.id)}
                className="accent-[var(--color-accent)] w-4 h-4 flex-shrink-0 cursor-pointer"
              />
              <span className="text-sm text-[var(--color-text)] truncate">{o.name}</span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[var(--color-border)] flex-shrink-0">
        <button onClick={cancelGroups} className="px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">Отмена</button>
        <button onClick={applyGroups} className="px-4 py-1.5 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity">Применить</button>
      </div>
    </Popover>
  );
}

// ── «Метрики» — вынесено отдельным компонентом (задача 1714): используется и в
// десктопной строке FilterBar, и внутри мобильной панели «Фильтры» (MobileReportBar),
// без второй копии разметки/бейджа.
export function MetricsButton({ onOpenMetricPanel, metricsBadge }: {
  onOpenMetricPanel: () => void; metricsBadge?: number;
}) {
  return (
    <button
      onClick={onOpenMetricPanel}
      className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
    >
      <SlidersHorizontal size={14} />
      Метрики
      {!!metricsBadge && (
        <span className="ml-1 px-1.5 py-0.5 bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-full text-[10px]">{metricsBadge}</span>
      )}
    </button>
  );
}

// ── Поиск — вынесено отдельным компонентом (задача 1714): ширина настраивается
// (`widthClassName`), чтобы в мобильной панели поле растягивалось на всю ширину
// (`w-full`), а в десктопной строке оставалось прежним `w-44`.
export function SearchField({ search, onSearchChange, widthClassName = 'w-44' }: {
  search: string; onSearchChange: (v: string) => void; widthClassName?: string;
}) {
  return (
    <div className={`relative ${widthClassName}`}>
      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
      <input
        type="text"
        value={search}
        onChange={e => onSearchChange(e.target.value)}
        placeholder="Поиск..."
        className="pl-8 pr-7 py-1.5 text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors w-full"
      />
      {search && (
        <button
          onClick={() => onSearchChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

// ── Селектор сущности (маркетинговые отчёты) — вынесен отдельным компонентом
// (задача 1714). `stacked` — вариант для мобильной панели: подпись сверху, полоса
// сегментов на всю ширину вместо строки «подпись + контрол» справа в тулбаре.
export function SourceDimensionSelector({ sourceDimension, onSourceDimensionChange, stacked = false }: {
  sourceDimension: SourceDimension; onSourceDimensionChange: (d: SourceDimension) => void; stacked?: boolean;
}) {
  const segs = (
    <div className={`flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm ${stacked ? 'w-full' : ''}`}>
      {SOURCE_DIMENSIONS.map(d => (
        <button
          key={d.key}
          onClick={() => onSourceDimensionChange(d.key)}
          className={`${stacked ? 'flex-1' : 'px-2.5'} py-1.5 transition-colors whitespace-nowrap ${sourceDimension === d.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
  if (stacked) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-wide">Сущность</div>
        {segs}
      </div>
    );
  }
  return (
    <div className="ml-auto flex items-center gap-2">
      <span className="text-sm text-[var(--color-text-muted)]">Сущность</span>
      {segs}
    </div>
  );
}

// ── Группировка — вынесена отдельным компонентом (задача 1714). `stacked` — вариант
// для мобильной панели «Фильтры» (подпись сверху, сегменты растянуты на всю ширину).
export function GroupingSelector({ grouping, onGroupingChange, stacked = false }: {
  grouping: Grouping; onGroupingChange: (g: Grouping) => void; stacked?: boolean;
}) {
  const segs = (
    <div className={`flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm ${stacked ? 'w-full' : ''}`}>
      {(['none', 'team', 'branch', 'total'] as Grouping[]).map(g => (
        <button
          key={g}
          onClick={() => onGroupingChange(g)}
          className={`${stacked ? 'flex-1' : 'px-3'} py-1.5 transition-colors ${grouping === g ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
        >
          {GROUPING_LABELS[g]}
        </button>
      ))}
    </div>
  );
  if (stacked) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-wide">Группировка</div>
        {segs}
      </div>
    );
  }
  return (
    <div className="ml-auto flex items-center gap-2">
      <span className="text-sm text-[var(--color-text-muted)]">Группировка</span>
      {segs}
    </div>
  );
}

export function FilterBar({ period, comparison, departmentIds, search = '', grouping, onPeriodChange, onComparisonChange, onDepartmentIdsChange, onSearchChange, onGroupingChange, onOpenMetricPanel, metricsBadge, showDepartments = true, sourceDimension, onSourceDimensionChange }: Props) {
  return (
    <div className="flex items-center gap-2 px-3 sm:px-6 py-2.5 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">

      <PeriodRangeControls
        period={period}
        comparison={comparison}
        onPeriodChange={onPeriodChange}
        onComparisonChange={onComparisonChange}
      />

      {/* ── Department picker ── */}
      {showDepartments && (
        <DepartmentPicker departmentIds={departmentIds} onDepartmentIdsChange={onDepartmentIdsChange} />
      )}

      {/* ── Metrics (legacy "Показатели") ── */}
      {onOpenMetricPanel && (
        <MetricsButton onOpenMetricPanel={onOpenMetricPanel} metricsBadge={metricsBadge} />
      )}

      {/* ── Search ── */}
      {onSearchChange && (
        <SearchField search={search} onSearchChange={onSearchChange} widthClassName="w-44" />
      )}

      {/* ── Source dimension (marketing reports, far right) ── */}
      {onSourceDimensionChange && sourceDimension !== undefined && (
        <SourceDimensionSelector sourceDimension={sourceDimension} onSourceDimensionChange={onSourceDimensionChange} />
      )}

      {/* ── Grouping (far right, labeled — matches the legacy tool everyone knows) ── */}
      {onGroupingChange && grouping !== undefined && (
        <GroupingSelector grouping={grouping} onGroupingChange={onGroupingChange} />
      )}
    </div>
  );
}
