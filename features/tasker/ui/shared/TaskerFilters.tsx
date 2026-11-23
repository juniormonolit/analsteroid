'use client';
// Общий фильтр трёх видов: РОП · менеджер · тема (метрика) · мои/наблюдаю. Только SearchSelect (CLAUDE.md, правило 14).
// Списки людей собираются из пришедших задач и копятся за сессию страницы: иначе после выбора
// менеджера в списке остался бы он один.
import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { TASKER_METRIC_GROUP_LABELS, type TaskerMetric, type TaskerPerson, type TaskerTasksResponse } from '../../types';
import type { TaskerFilterState } from './api';

const MINE_OPTIONS: SearchSelectOption[] = [
  { value: 'created', label: 'Я поставил' },
  { value: 'watch', label: 'Я наблюдаю' },
];

function usePeople(data: TaskerTasksResponse | undefined) {
  const [seen, setSeen] = useState<{ rops: Map<number, string>; managers: Map<number, string> }>(() => ({ rops: new Map(), managers: new Map() }));
  useEffect(() => {
    if (!data) return;
    setSeen(prev => {
      let changed = false;
      const rops = new Map(prev.rops), managers = new Map(prev.managers);
      const add = (m: Map<number, string>, p: TaskerPerson | null) => { if (p && !m.has(p.id)) { m.set(p.id, p.name); changed = true; } };
      for (const t of data.tasks) { add(managers, t.manager); add(rops, t.rop); }
      for (const s of data.sessions) { add(rops, s.rop); for (const m of s.managers) add(managers, m); }
      for (const e of data.trainings) add(managers, e.manager);
      return changed ? { rops, managers } : prev;
    });
  }, [data]);
  return seen;
}

const toOptions = (m: Map<number, string>, selected: string): SearchSelectOption[] => {
  const opts = [...m].map(([id, name]) => ({ value: String(id), label: name })).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  if (selected && !m.has(Number(selected))) opts.unshift({ value: selected, label: `№ ${selected}` });
  return opts;
};

export function TaskerFilters({ f, data, metrics }: { f: TaskerFilterState; data: TaskerTasksResponse | undefined; metrics: TaskerMetric[] }) {
  const people = usePeople(data);
  const ropOptions = useMemo(() => toOptions(people.rops, f.rop), [people.rops, f.rop]);
  const managerOptions = useMemo(() => toOptions(people.managers, f.manager), [people.managers, f.manager]);
  const metricOptions = useMemo(
    () => [...metrics].sort((a, b) => a.sortOrder - b.sortOrder).map(m => ({ value: m.id, label: m.label, hint: TASKER_METRIC_GROUP_LABELS[m.group] })),
    [metrics],
  );
  const cls = 'min-w-0 max-w-full';

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Фильтр задач">
      {ropOptions.length > 1 || f.rop ? (
        <SearchSelect ariaLabel="РОП" value={f.rop} onChange={f.setRop} allLabel="Все РОПы" options={ropOptions} searchPlaceholder="Поиск РОПа" className={cls} />
      ) : null}
      <SearchSelect ariaLabel="Менеджер" value={f.manager} onChange={f.setManager} allLabel="Все менеджеры" options={managerOptions}
        searchable searchPlaceholder="Поиск менеджера" className={cls} />
      <SearchSelect ariaLabel="Тема" value={f.metric} onChange={f.setMetric} allLabel="Все темы" options={metricOptions} searchPlaceholder="Поиск метрики" className={cls} />
      <SearchSelect ariaLabel="Чьи задачи" value={f.mine} onChange={v => f.setMine(v as TaskerFilterState['mine'])} allLabel="Все видимые" options={MINE_OPTIONS} className={cls} />
      {f.active && (
        <button type="button" onClick={f.reset}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
          <RotateCcw size={14} aria-hidden /> Сбросить
        </button>
      )}
    </div>
  );
}
