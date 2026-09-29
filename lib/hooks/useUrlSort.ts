'use client';
import { useCallback, useMemo } from 'react';
import { useUrlState } from './useUrlState';

// Сортировка таблицы в URL (задача #8126, находки 4, 18; правила Серёги «заголовки =
// сортировка» и «у каждого состояния свой URL»). Параметр `<key>=<колонка>:<asc|desc>`;
// цикл клика как на /rating (79daf81): убывание → возрастание → по умолчанию.
import { nextSort, parseSortParam, type SortState } from './sortCore';
export { sortRows, nextSort, parseSortParam, type SortState, type SortDir } from './sortCore';

export function useUrlSort<K extends string>(param: string, allowed: readonly K[], def: SortState<K> = { key: null, dir: 'desc' }) {
  const allowedKey = allowed.join(',');
  const [sort, setSort] = useUrlState<SortState<K>>(param, useMemo(() => ({
    parse: (raw: string) => parseSortParam(raw, allowed) ?? def,
    serialize: (v: SortState<K>) => (v.key ? `${v.key}:${v.dir}` : null),
    default: def,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [allowedKey, def.key, def.dir]));
  const toggle = useCallback((key: K) => setSort(cur => {
    const n = nextSort(cur, key);
    // «сброс» возвращает к дефолту таблицы (он не пишется в URL)
    return n.key === null ? def : n;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [setSort, def.key, def.dir]);
  return { sort, toggle, setSort };
}
