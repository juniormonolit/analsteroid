import { analyticsDb, systemDb } from '@/lib/db/clients';
import { addDays, startOfDay } from 'date-fns';
import { HOT_OBJECT_MIN_DEALS } from '@/lib/bitrix/dealAddress';
import { buildCommonDealWhere, type CommonDealFilterOpts } from './commonDealWhere';
import type { ProductGroupMode } from '@/lib/metrics/types';
import type { CalendarUnit } from '@/lib/period';

// ── Метрики объектов (задача владельца 21.09) ────────────────────────────────
//
// «Объект» = адрес доставки сделки. Разведка 21.09 показала, ради чего это
// вообще нужно: за 12 месяцев 6 797 объектов, отгрузок на объект 1,80, средний
// чек на ОБЪЕКТ 253 763 ₽ против 141 044 ₽ на сделку, а 30% объектов, куда
// вернулись, дают 68% денег. В единице «сделка» этого не видно.
//
// Данные сшиваются из двух баз, потому что писать в SA нам не дают (проверено:
// CREATE запрещён во всех схемах): сделки берём из sa.deals, адреса — из
// системной deal_addresses (кэш Битрикса, миграции 216–217). Отсюда порядок:
// SQL по сделкам → адреса по их id → агрегация в Node.
//
// Служебные точки (дефолт формы Битрикса, «просто город»: 32 адреса на треть
// базы) из расчёта исключены — иначе «объект» перестаёт что-либо значить.
//
// Все метрики считаются по ОТГРУЗКАМ (delivered_at) — та же шкала, что у
// отчёта «Повторные»: объект появляется, когда на него реально привезли.

export const OBJECTS_GRAND_TOTAL_KEY = '__objects_total__';

export const OBJECT_METRIC_IDS = [
  'objects_count',
  'objects_new',
  'objects_returned',
  'objects_return_pct',
  'objects_avg_check',
  'shipments_per_object',
  'address_fill_pct',
] as const;

export type ObjectMetricId = (typeof OBJECT_METRIC_IDS)[number];

export interface ObjectAgg {
  /** Разных объектов (адресов) в периоде. */
  objects: number;
  /** Из них таких, куда раньше НИКОГДА не отгружали. */
  newObjects: number;
  /** Из них таких, куда уже возили до начала периода («вернулись на объект»). */
  returned: number;
  /** Отгрузок с пригодным адресом (из них и считаются объекты). */
  addressedDeals: number;
  /** Сумма этих отгрузок. */
  addressedSum: number;
  /** ВСЕ отгрузки строки, включая безадресные — знаменатель дисциплины. */
  allDeals: number;
}

export type ObjectDim =
  | { kind: 'managers' }
  | { kind: 'product_groups'; mode: ProductGroupMode }
  | { kind: 'periods'; unit: CalendarUnit };

interface DealRow { k: string; deal_id: string; amount: string | null }

function keyExpr(dim: ObjectDim): string {
  switch (dim.kind) {
    case 'managers':
      return `COALESCE(d.current_manager_id::text, '')`;
    case 'product_groups':
      return dim.mode === 'by_max'
        ? `COALESCE(d.head_group_name, 'Без группы')`
        : `COALESCE(d.product_group_id::text, '__none__')`;
    case 'periods':
      // Ровно тот же ключ бакета, что строит bucketStartOf() в periodBuckets.ts
      // (МСК-дата начала бакета, 'YYYY-MM-DD'), иначе строки не сойдутся.
      return `to_char(date_trunc('${dim.unit}', d.delivered_at AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD')`;
  }
}

const empty = (): ObjectAgg => ({ objects: 0, newObjects: 0, returned: 0, addressedDeals: 0, addressedSum: 0, allDeals: 0 });

/**
 * Агрегаты объектов по измерению отчёта. Возвращает Map: ключ строки →
 * агрегат, плюс отдельный ключ OBJECTS_GRAND_TOTAL_KEY — честное «Итого»
 * (объекты НЕ складываются по строкам: один адрес может встретиться и у двух
 * менеджеров, и в двух товарных группах, и в двух месяцах).
 */
export async function fetchObjectMetrics(opts: {
  dim: ObjectDim;
  period: { from: Date; to: Date };
  /** Ограничение по срезу отчёта (отделы/тип аккаунта). null — без ограничения. */
  managerIds?: string[] | null;
  common?: CommonDealFilterOpts;
}): Promise<Map<string, ObjectAgg>> {
  const out = new Map<string, ObjectAgg>();
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const common = buildCommonDealWhere(opts.common ?? {}, 2);
  const params: unknown[] = [fromIso, toExclIso, ...common.params];
  const where = [
    `d.delivered_at IS NOT NULL`,
    `d.delivered_at >= $1::timestamptz AND d.delivered_at < $2::timestamptz`,
    // Гигиена как во всех отчётах: служебные воронки и мусорные суммы вне игры.
    `d.funnel_id IN (0,1,2,3)`,
    `COALESCE(d.amount, 0) BETWEEN 0 AND 50000000`,
  ];
  if (common.sql) where.push(common.sql);
  if (opts.managerIds) {
    if (opts.managerIds.length === 0) return out;
    params.push(opts.managerIds);
    where.push(`d.current_manager_id::text = ANY($${params.length}::text[])`);
  }

  const dealsRes = await analyticsDb().query<DealRow>(
    `SELECT ${keyExpr(opts.dim)} AS k, d.deal_id::text AS deal_id, d.amount::text AS amount
       FROM sa.deals d
      WHERE ${where.join(' AND ')}`,
    params,
  );
  if (dealsRes.rows.length === 0) return out;

  // Адреса этих сделок (без служебных точек).
  const ids = dealsRes.rows.map(r => Number(r.deal_id));
  const objOf = new Map<number, string>();
  const CHUNK = 5000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const res = await systemDb().query<{ deal_id: string; obj_key: string }>(
      `WITH hot AS (
         SELECT obj_key FROM deal_addresses
          WHERE found AND obj_key IS NOT NULL GROUP BY 1 HAVING count(*) >= $2
       )
       SELECT deal_id, obj_key FROM deal_addresses x
        WHERE found AND obj_key IS NOT NULL AND deal_id = ANY($1::bigint[])
          AND NOT EXISTS (SELECT 1 FROM hot WHERE hot.obj_key = x.obj_key)`,
      [ids.slice(i, i + CHUNK), HOT_OBJECT_MIN_DEALS],
    );
    for (const r of res.rows) objOf.set(Number(r.deal_id), r.obj_key);
  }

  // «Новый или вернулись»: по всем сделкам ЭТИХ объектов спрашиваем SA, была ли
  // отгрузка ДО начала периода. Две лёгкие выборки вместо истории в памяти.
  const objKeys = [...new Set([...objOf.values()])];
  const returnedObjects = new Set<string>();
  if (objKeys.length > 0) {
    const histIds: { dealId: number; objKey: string }[] = [];
    for (let i = 0; i < objKeys.length; i += CHUNK) {
      const res = await systemDb().query<{ deal_id: string; obj_key: string }>(
        `SELECT deal_id, obj_key FROM deal_addresses WHERE found AND obj_key = ANY($1::text[])`,
        [objKeys.slice(i, i + CHUNK)],
      );
      for (const r of res.rows) histIds.push({ dealId: Number(r.deal_id), objKey: r.obj_key });
    }
    const objByDeal = new Map(histIds.map(h => [h.dealId, h.objKey]));
    const allHist = [...objByDeal.keys()];
    for (let i = 0; i < allHist.length; i += 20000) {
      const res = await analyticsDb().query<{ deal_id: string }>(
        `SELECT d.deal_id::text AS deal_id FROM sa.deals d
          WHERE d.deal_id = ANY($1::bigint[]) AND d.delivered_at IS NOT NULL AND d.delivered_at < $2::timestamptz`,
        [allHist.slice(i, i + 20000), fromIso],
      );
      for (const r of res.rows) {
        const k = objByDeal.get(Number(r.deal_id));
        if (k) returnedObjects.add(k);
      }
    }
  }

  // Агрегация по ключу строки + отдельный «настоящий» итог.
  const objsByKey = new Map<string, Set<string>>();
  const totalObjs = new Set<string>();
  const bump = (key: string, objKey: string | undefined, amount: number) => {
    const a = out.get(key) ?? empty();
    a.allDeals++;
    if (objKey) {
      a.addressedDeals++;
      a.addressedSum += amount;
      const set = objsByKey.get(key) ?? new Set<string>();
      set.add(objKey);
      objsByKey.set(key, set);
    }
    out.set(key, a);
  };

  for (const r of dealsRes.rows) {
    const amount = Number(r.amount ?? 0) || 0;
    const objKey = objOf.get(Number(r.deal_id));
    bump(r.k, objKey, amount);
    bump(OBJECTS_GRAND_TOTAL_KEY, objKey, amount);
    if (objKey) totalObjs.add(objKey);
  }

  for (const [key, set] of objsByKey) {
    const a = out.get(key)!;
    a.objects = set.size;
    a.returned = [...set].filter(k => returnedObjects.has(k)).length;
    a.newObjects = a.objects - a.returned;
  }
  const total = out.get(OBJECTS_GRAND_TOTAL_KEY);
  if (total) {
    total.objects = totalObjs.size;
    total.returned = [...totalObjs].filter(k => returnedObjects.has(k)).length;
    total.newObjects = total.objects - total.returned;
  }
  return out;
}

/** Значения метрик каталога из агрегата (null там, где делить не на что). */
export function objectMetricValues(a: ObjectAgg | undefined): Record<ObjectMetricId, number | null> {
  if (!a) {
    return {
      objects_count: null, objects_new: null, objects_returned: null, objects_return_pct: null,
      objects_avg_check: null, shipments_per_object: null, address_fill_pct: null,
    };
  }
  return {
    objects_count: a.objects,
    objects_new: a.newObjects,
    objects_returned: a.returned,
    objects_return_pct: a.objects > 0 ? Math.round((a.returned / a.objects) * 1000) / 10 : null,
    objects_avg_check: a.objects > 0 ? Math.round(a.addressedSum / a.objects) : null,
    shipments_per_object: a.objects > 0 ? Math.round((a.addressedDeals / a.objects) * 100) / 100 : null,
    address_fill_pct: a.allDeals > 0 ? Math.round((a.addressedDeals / a.allDeals) * 1000) / 10 : null,
  };
}

/**
 * Менеджеры среза отчёта для измерений, где строка — не менеджер (товарные
 * группы, периоды). Та же выборка, что в byProductGroups/byPeriods: иначе
 * метрика объектов игнорировала бы фильтр по отделу и расходилась бы с
 * соседними колонками.
 */
export async function resolveObjectScopeManagers(
  departmentIds: string[] | undefined, managerId?: string | number | null,
): Promise<string[] | null> {
  if (managerId !== undefined && managerId !== null && String(managerId).trim() !== '') return [String(managerId)];
  if (!departmentIds || departmentIds.length === 0) return null;
  const res = await analyticsDb().query<{ bitrix_user_id: string }>(
    `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
       FROM sa.org_resolved_hierarchy orh
      WHERE orh.department_id IN (
        SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
      )
        AND orh.is_active = true`,
    [departmentIds],
  );
  return res.rows.map(r => r.bitrix_user_id).filter(id => /^\d+$/.test(id));
}
