// «Дашборд тест» — сделки менеджера за день: третий уровень раскрытия
// (карточка → окно «Менеджеры» → продажи или брони менеджера списком сделок).
//
// Список обязан сходиться с числом в строке менеджера, поэтому условия отбора — те же,
// что у раскрытия на «РОП — сегодня» (features/tv/engine/dashboardDrilldown.ts, здесь
// только импорт): продажи — по sold_at в воронках первичных и повторных, брони — по
// reserved_at без фильтра воронки; менеджер — по current_manager_id. Своя здесь только
// дата: дашборд может показывать не сегодняшний день (см. build.ts).

import { analyticsDb } from '@/lib/db/clients';
import { addDaysStr, mskMidnightIso } from '@/features/tv/engine/feed';
import { dateColumnFor, funnelConditionFor } from '@/features/tv/engine/dashboardDrilldown';

export type DashTestDealKind = 'sales' | 'book';

export interface DashTestDealProduct { name: string; quantity: number; sum: number }

export interface DashTestDeal {
  id: number;
  name: string;
  amount: number;
  /** Момент продажи (sales) или брони (book), ISO. */
  at: string;
  funnel: string | null;
  isRepeat: boolean;
  group: string | null;
  stage: string | null;
  products: DashTestDealProduct[];
}

export interface DashTestDealsResponse {
  day: string;
  kind: DashTestDealKind;
  managerId: string;
  deals: DashTestDeal[];
  totalCount: number;
  totalAmount: number;
}

const LIMIT = 300;

function parseProducts(raw: unknown): DashTestDealProduct[] {
  if (!Array.isArray(raw)) return [];
  const out: DashTestDealProduct[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name : '';
    if (!name) continue;
    out.push({ name, quantity: Number(r.quantity) || 0, sum: Math.round(Number(r.sum) || 0) });
  }
  return out;
}

export async function fetchManagerDeals(kind: DashTestDealKind, managerId: string, day: string): Promise<DashTestDealsResponse> {
  const empty: DashTestDealsResponse = { day, kind, managerId, deals: [], totalCount: 0, totalAmount: 0 };
  const idNum = Number(managerId);
  if (!Number.isInteger(idNum) || idNum <= 0) return empty;
  const dateCol = dateColumnFor(kind);
  const res = await analyticsDb().query<{
    deal_id: number; deal_name: string | null; amount: string | null; at: Date | string; products: unknown;
    funnel_name: string | null; is_repeat: boolean; group_name: string | null; stage_name: string | null;
    total_count: number; total_amount: string | null;
  }>(
    `SELECT d.deal_id, d.deal_name, d.amount, d.${dateCol} AS at, d.products,
            f.name AS funnel_name, COALESCE(f.is_repeat, false) AS is_repeat,
            COALESCE(pg.name, d.head_group_name) AS group_name, s.name AS stage_name,
            (COUNT(*) OVER ())::int AS total_count, SUM(d.amount) OVER () AS total_amount
       FROM deals d
       LEFT JOIN stages s ON s.id = d.stage_id
       LEFT JOIN product_groups pg ON pg.id = d.product_group_id
       LEFT JOIN funnels f ON f.id = d.funnel_id
      WHERE d.${dateCol} >= $1 AND d.${dateCol} < $2
        AND d.current_manager_id = $3
        ${funnelConditionFor(kind)}
      ORDER BY d.${dateCol} DESC
      LIMIT ${LIMIT}`,
    [mskMidnightIso(day), mskMidnightIso(addDaysStr(day, 1)), idNum],
  );
  return {
    day, kind, managerId,
    deals: res.rows.map(r => ({
      id: r.deal_id,
      name: r.deal_name || `Сделка #${r.deal_id}`,
      amount: Math.round(Number(r.amount ?? 0)),
      at: new Date(r.at).toISOString(),
      funnel: r.funnel_name, isRepeat: r.is_repeat, group: r.group_name, stage: r.stage_name,
      products: parseProducts(r.products),
    })),
    totalCount: res.rows[0]?.total_count ?? 0,
    totalAmount: Math.round(Number(res.rows[0]?.total_amount ?? 0)),
  };
}
