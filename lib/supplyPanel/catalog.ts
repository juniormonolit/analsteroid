/**
 * Привязка к товарному каталогу Bitrix24 — порт refresh/catalog.py (paths, is_service, SERVICE_SECTIONS);
 * REST-выгрузка каталога не переносится: таблицы cat_* приходят из источника.
 *
 * ВАЖНО: кэш resolve повторяет поведение Python байт-в-байт, включая его особенность — после разбора
 * предложения переменная pid указывает на карточку, и в кэш путь кладётся под id карточки. Поэтому результат
 * resolve зависит от порядка вызовов; порядок вызовов в calc.ts/domcalc совпадает с Python.
 */
import type { Row } from './source';

/** Корневые разделы каталога с услугами (решение владельца Панели 22.09.2026). */
export const SERVICE_SECTIONS = new Set([181, 95, 107, 101, 182, 14]);

export interface Catalog {
  resolve: (pid: number | null) => string[] | null;
  names: Record<string, string | null>;
  parents: Map<string, string | null>;
  offers: Map<number, [string | null, number | null]>;
  products: Map<number, [string | null, number | null]>;
}

const pairMap = (rows: Row[], a: string, b: string): Map<number, [string | null, number | null]> => {
  const m = new Map<number, [string | null, number | null]>();
  for (const r of rows) m.set(r.id as number, [r[a] as string | null, r[b] as number | null]);
  return m;
};

export function makeCatalog(secRows: Row[], prodRows: Row[], offRows: Row[]): Catalog {
  const sections = pairMap(secRows, 'name', 'parent_id');
  const products = pairMap(prodRows, 'name', 'section_id');
  const offers = pairMap(offRows, 'name', 'parent_id');
  const names: Record<string, string | null> = {};
  const parents = new Map<string, string | null>();
  const cache = new Map<number | null, string[] | null>();

  const resolve = (pid0: number | null): string[] | null => {
    let pid = pid0;
    if (cache.has(pid)) return cache.get(pid)!;
    const path: string[] = [];
    if (pid !== null && offers.has(pid)) {
      const o = offers.get(pid)!;
      path.push(`o${pid}`);
      names[`o${pid}`] = o[0];
      pid = o[1];
    }
    if (pid === null || !products.has(pid)) {
      cache.set(pid, null);
      return null;
    }
    const p = products.get(pid)!;
    path.push(`p${pid}`);
    names[`p${pid}`] = p[0];
    let sid = p[1];
    while (sid !== null && sections.has(sid)) {
      const s = sections.get(sid)!;
      path.push(`s${sid}`);
      names[`s${sid}`] = s[0];
      sid = s[1];
    }
    if (!path[path.length - 1]!.startsWith('s')) {
      path.push('s0');
      names['s0'] = 'Без раздела';
    }
    path.reverse();
    for (let i = 0; i < path.length; i++) parents.set(path[i]!, i ? path[i - 1]! : null);
    cache.set(pid, path); // как в Python: pid уже переназначен на карточку
    return path;
  };
  return { resolve, names, parents, offers, products };
}

export function isService(path: string[] | null): boolean {
  return !!path && path.length > 0 && SERVICE_SECTIONS.has(Number(path[0]!.slice(1)));
}
