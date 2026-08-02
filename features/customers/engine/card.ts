import { analyticsDb, systemDb } from '@/lib/db/clients';
import type { MarkKind, NoCallReason } from './customers';
import { CLIENT_KEY_CASE_SQL } from './clientKey';

// ── Карточка клиента (фича Серёги 01.08, вместе с редизайном «Моих заказчиков») ─
// Дополнительные данные к строке списка: таймлайн покупок, звонки, отказы,
// история отметок. Шапка/активные сделки/рекомендации в карточку приходят из
// уже посчитанной строки списка (ApiRow) — тут только то, чего в строке нет.
// Клиент = та же сегментация, что в движке списка (funnel 0/2 → contact,
// 1/3 → company; воронки 4/7 исключены).

export interface TimelineDeal {
  dealId: number;
  name: string | null;
  amount: number | null;
  soldAt: string;            // ISO
  managerId: number | null;
  groups: string[];
}
export interface RefusedDeal {
  dealId: number;
  name: string | null;
  amount: number | null;
  lostAt: string;            // ISO
  hasCall: boolean;
}
export interface MarkHistoryItem {
  action: MarkKind | 'clear';
  snoozeUntil: string | null;
  reason: NoCallReason | null;
  comment: string | null;
  createdBy: string;
  createdAt: string;         // ISO
}
export interface CustomerCardData {
  timeline: TimelineDeal[];          // хронологически, старые сверху
  calls: { total: number; lastAt: string | null; byYear: { year: number; count: number }[] };
  refused: RefusedDeal[];
  markHistory: MarkHistoryItem[];
}

function toIso(v: string | Date | null): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

// Формула ключа — ЕДИНАЯ с customers.ts/crossSell.ts (задача 2776, фикс
// «k0»): clientKey от списка должен матчиться СЮДА же 1:1, иначе карточка
// клиента откроется пустой или (хуже) подмешает чужие сделки.
const CLIENT_DEALS_CTE = `
WITH cdeals AS (
  SELECT d.*
  FROM sa.deals d
  WHERE d.funnel_id IN (0,1,2,3)
    AND (${CLIENT_KEY_CASE_SQL}) = $1
)`;

export async function fetchCustomerCard(clientKey: string): Promise<CustomerCardData> {
  const db = analyticsDb();

  const [timelineRes, callsRes, byYearRes, refusedRes] = await Promise.all([
    db.query<{ deal_id: number; deal_name: string | null; amount: string | null; sold_at: string | Date; current_manager_id: number | null; grps: string[] | null }>(
      `${CLIENT_DEALS_CTE}
       SELECT d2.deal_id, d2.deal_name, d2.amount::text, d2.sold_at, d2.current_manager_id,
              array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d2.products) p
                    WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                      AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps
       FROM cdeals d2 WHERE d2.sold_at IS NOT NULL
       ORDER BY d2.sold_at ASC, d2.deal_id ASC`,
      [clientKey],
    ),
    db.query<{ total: string; last_at: string | Date | null }>(
      `${CLIENT_DEALS_CTE}
       SELECT count(*)::text AS total, max(c.called_at) AS last_at
       FROM va.calls c WHERE c.deal_id IN (SELECT deal_id FROM cdeals)`,
      [clientKey],
    ),
    db.query<{ y: string; cnt: string }>(
      `${CLIENT_DEALS_CTE}
       SELECT extract(year FROM c.called_at)::int::text AS y, count(*)::text AS cnt
       FROM va.calls c WHERE c.deal_id IN (SELECT deal_id FROM cdeals)
       GROUP BY 1 ORDER BY 1`,
      [clientKey],
    ),
    db.query<{ deal_id: number; deal_name: string | null; amount: string | null; lost_at: string | Date; has_call: boolean }>(
      `${CLIENT_DEALS_CTE}
       SELECT d2.deal_id, d2.deal_name, d2.amount::text, d2.lost_at,
              EXISTS (SELECT 1 FROM va.calls c WHERE c.deal_id = d2.deal_id) AS has_call
       FROM cdeals d2 WHERE d2.lost_at IS NOT NULL
       ORDER BY d2.lost_at DESC LIMIT 50`,
      [clientKey],
    ),
  ]);

  // История отметок — системная БД (миграция 128); таблицы может не быть до
  // выкатки миграции — тогда честный пустой список, а не 500 всей карточки.
  let markHistory: MarkHistoryItem[] = [];
  try {
    const mh = await systemDb().query<{
      action: string; snooze_until: string | null; reason: string | null;
      comment: string | null; created_by: string; created_at: string | Date;
    }>(
      `SELECT action, to_char(snooze_until, 'YYYY-MM-DD') AS snooze_until, reason, comment, created_by, created_at
       FROM customer_mark_history WHERE client_key = $1
       ORDER BY created_at DESC LIMIT 50`,
      [clientKey],
    );
    markHistory = mh.rows.map(r => ({
      action: r.action as MarkHistoryItem['action'],
      snoozeUntil: r.snooze_until,
      reason: (r.reason as NoCallReason | null),
      comment: r.comment,
      createdBy: r.created_by,
      createdAt: toIso(r.created_at)!,
    }));
  } catch { /* таблицы ещё нет */ }

  return {
    timeline: timelineRes.rows.map(r => ({
      dealId: r.deal_id,
      name: r.deal_name,
      amount: r.amount !== null ? Math.round(Number(r.amount)) : null,
      soldAt: toIso(r.sold_at)!,
      managerId: r.current_manager_id,
      groups: r.grps ?? [],
    })),
    calls: {
      total: Number(callsRes.rows[0]?.total ?? 0),
      lastAt: toIso(callsRes.rows[0]?.last_at ?? null),
      byYear: byYearRes.rows.map(r => ({ year: Number(r.y), count: Number(r.cnt) })),
    },
    refused: refusedRes.rows.map(r => ({
      dealId: r.deal_id,
      name: r.deal_name,
      amount: r.amount !== null ? Math.round(Number(r.amount)) : null,
      lostAt: toIso(r.lost_at)!,
      hasCall: r.has_call,
    })),
    markHistory,
  };
}
