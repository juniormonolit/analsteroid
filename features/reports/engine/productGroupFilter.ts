import type { ProductGroupMode } from '@/lib/metrics/types';

// Параметризованный фильтр по товарным группам (задача владельца 29.07, «Графики»:
// фильтр по товарным группам + расхардкодить шкалу в «Конструкторе»). ДВЕ формы
// входа сосуществуют:
//  * productGroupId  — legacy ОДИНОЧНЫЙ id (дрилл-даун DrilldownDrawer, byManagers.ts/
//    byProductGroups.ts уже принимали его РАНЬШЕ этой задачи, но строили WHERE
//    конкатенацией строки — `d.product_group_id = ${pgId}` / `d.head_group_name =
//    '${pgId.replace(...)}'`. Это НЕ параметризованный SQL (правило CLAUDE.md —
//    только параметризованные запросы), просто прежде было прикрыто ручной
//    regex-валидацией цифр и ручным экранированием кавычки. Здесь оба пути
//    переведены на bound-параметры $N.
//  * productGroupIds — НОВЫЙ множественный набор (мультиселект раздела «Графики»).
//
// Раздельная функция, а не встроенный код в byManagers.ts/byProductGroups.ts:
// notNullWhere-текст одного и того же фильтра нужен ДВУМ разным SQL-запросам с
// РАЗНЫМ числом уже занятых позиционных параметров (основной collected-запрос —
// $1/$2 период; снимок «Стадии (сейчас)» в stageSnapshot.ts — только $1 массив
// stage_id). paramOffset — сколько параметров ЭТОГО конкретного запроса уже занято
// ДО вызова; функция возвращает SQL с плейсхолдерами, продолжающими нумерацию
// оттуда, и params — что добавить к массиву параметров запроса.
export interface ProductGroupFilterInput {
  productGroupMode?: ProductGroupMode;
  productGroupId?: string;     // legacy одиночный (дрилл-даун)
  productGroupIds?: string[];  // множественный (мультиселект «Графики»)
}

export interface ProductGroupFilter {
  sql: string;       // готовое условие в скобках, например "(d.product_group_id = ANY($3::int[]))"
  params: unknown[]; // добавить к массиву параметров запроса (в этом порядке)
}

const MAX_IDS = 200; // разумный потолок — в kc сейчас ~96 групп, с запасом на рост

/**
 * pgFilterOffset — число уже занятых позиционных параметров конкретного SQL,
 * в который встраивается результат (например: у основного collected-запроса
 * byManagers это 2 — [fromIso, toExclIso]; у снимка stageSnapshot — 1 —
 * [CURATED_STAGE_IDS]). Вызывающий код обязан добавить filter.params к СВОЕМУ
 * массиву параметров именно в этом порядке (после уже существующих).
 */
export function buildProductGroupFilter(
  input: ProductGroupFilterInput,
  paramOffset: number,
): ProductGroupFilter | undefined {
  const mode = input.productGroupMode ?? 'kc';

  let ids: string[] | undefined;
  if (input.productGroupIds && input.productGroupIds.length > 0) {
    ids = input.productGroupIds.slice(0, MAX_IDS);
  } else if (input.productGroupId !== undefined) {
    ids = [input.productGroupId];
  }
  if (!ids || ids.length === 0) return undefined;

  const params: unknown[] = [];
  const parts: string[] = [];

  if (mode === 'kc') {
    // '__none__' — сентинел «Без группы» (product_group_id IS NULL), тот же, что
    // использовался в старом одиночном pgId-пути (idExpr в byProductGroups.ts).
    const hasNone = ids.includes('__none__');
    const numericIds = [...new Set(ids.filter(id => /^\d+$/.test(id)).map(Number))];
    if (numericIds.length > 0) {
      params.push(numericIds);
      parts.push(`d.product_group_id = ANY($${paramOffset + params.length}::int[])`);
    }
    if (hasNone) parts.push('d.product_group_id IS NULL');
  } else {
    // by_max: head_group_name — строка от клиента. Никакой конкатенации/ручного
    // экранирования — ANY($N::text[]) параметризует значения целиком, включая
    // одинарные кавычки/спецсимволы в названиях групп.
    const hasNone = ids.includes('Без группы');
    const names = [...new Set(
      ids.filter(id => id !== 'Без группы' && typeof id === 'string' && id.length > 0 && id.length <= 200),
    )];
    if (names.length > 0) {
      params.push(names);
      parts.push(`d.head_group_name = ANY($${paramOffset + params.length}::text[])`);
    }
    if (hasNone) parts.push('d.head_group_name IS NULL');
  }

  if (parts.length === 0) return undefined;
  return { sql: parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0], params };
}

// Стабильный ключ для кэшей (rowCache/snapshotCache) — не зависит от порядка ids.
// ВСЕГДА включает mode (даже когда ids пуст) — kc/by_max дают РАЗНЫЙ SQL (разный
// idExpr/groupBy в byProductGroups.ts), поэтому без mode в ключе пустой фильтр обеих
// шкал схлопнулся бы в один и тот же ключ 'all' и отдавал бы друг другу чужие
// закэшированные строки (найдено при ревью этой же задачи, до попадания в прод).
export function productGroupCacheKey(input: ProductGroupFilterInput): string {
  const mode = input.productGroupMode ?? 'kc';
  const ids = input.productGroupIds?.length ? input.productGroupIds : (input.productGroupId !== undefined ? [input.productGroupId] : []);
  return ids.length === 0 ? `${mode}:all` : `${mode}:${[...ids].sort().join(',')}`;
}
