// Чистые функции сортировки таблиц (задача #8126) — без React/Next, тестируются
// scripts/assert-realizations.ts. Хук с URL — useUrlSort.ts.
export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string> { key: K | null; dir: SortDir }

export function parseSortParam<K extends string>(raw: string, allowed: readonly K[]): SortState<K> | null {
  const [k, d] = raw.split(':');
  if (!(allowed as readonly string[]).includes(k) || (d !== 'asc' && d !== 'desc')) return null;
  return { key: k as K, dir: d };
}

/** Следующее состояние по клику: другая колонка → desc; та же: desc → asc → сброс. */
export function nextSort<K extends string>(cur: SortState<K>, key: K): SortState<K> {
  if (cur.key !== key) return { key, dir: 'desc' };
  if (cur.dir === 'desc') return { key, dir: 'asc' };
  return { key: null, dir: 'desc' };
}

export function sortRows<T, K extends string>(rows: T[], sort: SortState<K>, get: (r: T, k: K) => number | string | null | undefined): T[] {
  if (!sort.key) return rows;
  const k = sort.key;
  const out = [...rows];
  out.sort((a, b) => {
    const va = get(a, k), vb = get(b, k);
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1; // пустые — всегда внизу
    if (vb === null || vb === undefined) return -1;
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ru');
    return sort.dir === 'asc' ? c : -c;
  });
  return out;
}

