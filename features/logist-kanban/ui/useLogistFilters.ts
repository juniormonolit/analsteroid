'use client';
// Фильтры доски запросов логистам — в адресной строке (правило «у экрана воспроизводимый URL», useUrlState).
// Списки — повторяющимися ключами (`?queue=5&queue=7`, в названиях товарных групп запятые), поэтому не
// useUrlState по ключу, а общий разбор/сборка движка: parseFilters / filtersToSearchParams (engine/requests/filters.ts).
// URL — источник правды: читаем useSearchParams() на каждом рендере, своего useState нет.
import { useCallback, useMemo, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { LogistFilters } from '../engine/requests/contract';
import { filtersToSearchParams, parseFilters } from '../engine/requests/filters';

/** Поля, которые живут в панели «Фильтры» (остальное — на виду: поиск, тип, «мои», «не взятые»). */
const PANEL_KEYS: (keyof LogistFilters)[] = [
  'queues', 'regions', 'depts', 'productGroups', 'managers', 'managerDepts', 'logists', 'statuses', 'sla', 'returned',
  'sumMin', 'sumMax', 'createdFrom', 'createdTo', 'outcome', 'sort',
];

const isOn = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '');

export function useLogistFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const key = sp.toString();
  const filters = useMemo(() => parseFilters(new URLSearchParams(key)), [key]);
  // Несколько set() в одном обработчике не должны затирать друг друга — копим от последнего записанного.
  const latest = useRef<{ key: string; f: LogistFilters }>({ key, f: filters });
  if (latest.current.key !== key) latest.current = { key, f: filters };

  const replace = useCallback((next: LogistFilters) => {
    latest.current = { key: latest.current.key, f: next };
    const qs = filtersToSearchParams(next, new URLSearchParams(window.location.search)).toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname]);

  const set = useCallback(<K extends keyof LogistFilters>(k: K, v: LogistFilters[K]) => {
    const next = { ...latest.current.f };
    if (isOn(v)) next[k] = v; else delete next[k];
    replace(next);
  }, [replace]);

  const panelActive = PANEL_KEYS.filter(k => isOn(filters[k]) && !(k === 'sumMax' && isOn(filters.sumMin)) && !(k === 'createdTo' && isOn(filters.createdFrom))).length;
  const anyActive = Object.values(filters).some(isOn);

  const resetPanel = () => {
    const next = { ...latest.current.f };
    for (const k of PANEL_KEYS) delete next[k];
    replace(next);
  };
  const resetAll = () => replace({});

  return { filters, set, replace, panelActive, anyActive, resetPanel, resetAll, queryString: filtersToSearchParams(filters).toString() };
}
export type LogistFilterState = ReturnType<typeof useLogistFilters>;
