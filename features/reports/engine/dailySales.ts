// Дневной агрегат продаж для графика «Динамика продаж за 30 дней» (Сводная, задача
// 1704). Единственный блок дашборда без готового движка (grouping в byManagers.ts
// поддерживает только none/team/branch/total, дневного bucket там нет — см.
// owners-inbox/monolitika-summary-dashboard-proposal.md, п.2, блок 6).
//
// Определение «продажи» — НЕ придумано заново: metrics.id='sales_count' в каталоге
// (lib/metrics/catalog.ts) определена как source='deals', agg_fn='count_distinct',
// agg_field='deal_id', date_field='sold_at', БЕЗ фильтра funnel_type (первичные +
// повторные вместе) — проверено живым запросом к таблице metrics 11.07. Сумма —
// 'primary_sales_amount'+'repeat_sales_amount' объединены аналогично (agg_field=amount,
// тот же date_field='sold_at'). Этот файл считает day_trunc(sold_at) по ТЕМ ЖЕ
// колонкам (sa.deals.sold_at, sa.deals.amount, sa.deals.current_manager_id) —
// никакого нового понятия «продажа» не вводится.
//
// Группировка по менеджеру (не сразу по компании) — чтобы ОДИН незакэшированный
// результат можно было переиспользовать для ЛЮБОГО смотрящего: агрегация по
// managerIds (права «Руководит», см. lib/summary/scope.ts) происходит в JS ПОСЛЕ
// чтения кэша, тем же приёмом, что buildTeamRoster/buildDepartmentCard
// (features/manager-card/engine/teamCard.ts) уже используют для company-wide пула.

import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, type DateRange } from '@/lib/period';

export interface DailySalesManagerRow {
  day: string;          // YYYY-MM-DD (МСК-календарная дата)
  managerId: string;
  salesCount: number;
  salesAmount: number;
}

/**
 * Один агрегатный запрос, группировка (день МСК, менеджер). Без периода дороже 30
 * дней не вызывается — объём (~30 дней × активных менеджеров) на порядки меньше
 * патологического кейса stageConversions (см. комментарий там), отдельного
 * двухзапросного разбиения не потребовалось.
 *
 * toSqlInterval — тот же хелпер, что и остальные движки отчётов (byManagers и т.п.),
 * никакой отдельной date-границы не изобретаем.
 */
export async function fetchDailySalesByManager(period: DateRange): Promise<DailySalesManagerRow[]> {
  const { from, toExcl } = toSqlInterval(period);
  const res = await analyticsDb().query<{ day: string; manager_id: string; sales_count: string; sales_amount: string }>(
    `
    SELECT
      to_char(sold_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
      current_manager_id::text AS manager_id,
      COUNT(DISTINCT deal_id) AS sales_count,
      COALESCE(SUM(amount), 0) AS sales_amount
    FROM deals
    WHERE sold_at >= $1 AND sold_at < $2 AND current_manager_id IS NOT NULL
    GROUP BY 1, 2
    `.trim(),
    [from, toExcl],
  );

  return res.rows.map(r => ({
    day: r.day,
    managerId: r.manager_id,
    salesCount: Number(r.sales_count),
    salesAmount: Number(r.sales_amount),
  }));
}

export interface DailySalesPoint { date: string; salesCount: number; salesAmount: number }

/**
 * Схлопывает per-manager строки в непрерывный дневной ряд (нулевые дни не выпадают),
 * уже с фильтром по managerIds. fromDayStr/toDayStrIncl — date-only строки
 * (YYYY-MM-DD, МСК-календарь) — та же «буквальная» семантика, что periodDateStr в
 * lib/period (день берётся как есть, без Date-роундтрипа/сдвига пояса).
 */
export function aggregateDailySales(
  rows: DailySalesManagerRow[],
  managerIds: Set<string>,
  fromDayStr: string,
  toDayStrIncl: string,
): DailySalesPoint[] {
  const byDay = new Map<string, { count: number; amount: number }>();
  for (const r of rows) {
    if (!managerIds.has(r.managerId)) continue;
    const acc = byDay.get(r.day) ?? { count: 0, amount: 0 };
    acc.count += r.salesCount;
    acc.amount += r.salesAmount;
    byDay.set(r.day, acc);
  }

  const out: DailySalesPoint[] = [];
  let cur = fromDayStr;
  let guard = 0;
  while (cur <= toDayStrIncl && guard < 400) {
    const acc = byDay.get(cur);
    out.push({ date: cur, salesCount: acc?.count ?? 0, salesAmount: acc?.amount ?? 0 });
    const next = new Date(`${cur}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cur = next.toISOString().slice(0, 10);
    guard++;
  }
  return out;
}
