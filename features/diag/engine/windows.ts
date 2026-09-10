// Тиковые окна менеджера (ТЗ §4, решение владельца 10.09: окно = N последних закрытых
// сделок, включая зомби; тик = 10; без лимита по дням). Закрытая сделка = продана, отказ
// или зомби (без брони дольше порога группы — считается проигранной только здесь).
// Атрибуция — только deals.current_manager_id. Повторность — по истории клиента
// (отгрузка того же контакта/компании раньше created_at), не по воронке.
// Из одного запроса берём 2N закрытых: первые N — текущее окно, следующие N — «own»-база
// (непересекающееся окно). Значения всех тиковых узлов считаются в JS из этого набора.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadPriceStageSets } from '@/lib/settings/priceStageMarkup';
import { loadDiagSettings } from './settings';
import { loadZombieThresholds } from './refs';

export interface WindowDeal {
  dealId: string; headGroup: string; funnelId: number; isRepeatHist: boolean; amount: number;
  createdAt: Date; pricedAt: Date | null; reservedAt: Date | null; soldAt: Date | null; lostAt: Date | null; deliveredAt: Date | null;
  outcome: 'won' | 'lost' | 'zombie'; closedAt: Date;
  calls: number; firstCompletedCallAt: Date | null; bookingCalledNextDay: boolean | null; // null — брони не было или срок не наступил
}

export interface ManagerWindow {
  managerId: number;
  current: WindowDeal[];   // последние N закрытых
  previous: WindowDeal[];  // предыдущие N (own-база)
  openDeals: { total: number; zombie: number; silence7: number };
  tickNo: number;          // floor(всего закрытых / tick)
}

export interface NodeValue { value: number | null; n: number; kind: 'share' | 'mean' | 'count' }

const clientKey = (funnelId: number, contactId: string | null, companyId: string | null) =>
  funnelId === 0 || funnelId === 2 ? (contactId ? `c${contactId}` : null) : (companyId && companyId !== '0' ? `k${companyId}` : contactId ? `c${contactId}` : null);

async function loadNextWorkingDayFn(): Promise<(dateStr: string) => string> {
  const res = await systemDb().query<{ d: string; is_working: boolean }>(`SELECT to_char(date, 'YYYY-MM-DD') AS d, is_working FROM working_calendar`);
  const cal = new Map(res.rows.map(r => [r.d, r.is_working]));
  const isWorking = (s: string) => { const v = cal.get(s); if (v !== undefined) return v; const dow = new Date(`${s}T12:00:00Z`).getUTCDay(); return dow !== 0 && dow !== 6; };
  return (dateStr: string) => { let d = new Date(`${dateStr}T12:00:00Z`); for (let i = 0; i < 14; i++) { d = new Date(d.getTime() + 86400000); const s = d.toISOString().slice(0, 10); if (isWorking(s)) return s; } return dateStr; };
}
const mskDay = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

/** Запрос к SA с statement_timeout: тяжёлый SQL должен упасть с ошибкой, а не висеть. */
async function saQuery<T extends Record<string, unknown>>(sql: string, params: unknown[], timeoutSec = 240): Promise<{ rows: T[]; ms: number }> {
  const client = await analyticsDb().connect();
  const t0 = Date.now();
  try {
    await client.query(`SET statement_timeout = '${timeoutSec}s'`);
    const r = await client.query<T>(sql, params);
    return { rows: r.rows, ms: Date.now() - t0 };
  } finally { client.release(); }
}

/** Окна для набора менеджеров — одним запросом по сделкам и одним по звонкам. */
export async function loadManagerWindows(managerIds: number[]): Promise<Map<number, ManagerWindow>> {
  const out = new Map<number, ManagerWindow>();
  if (!managerIds.length) return out;
  const s = await loadDiagSettings();
  const z = await loadZombieThresholds();
  const { hasPrice } = await loadPriceStageSets();
  const nextWorkingDay = await loadNextWorkingDayFn();
  const N = s.windowClosed;
  const timings: Record<string, number> = {};

  const deals = await saQuery<{
    manager_id: string; deal_id: string; head_group_name: string | null; funnel_id: number; amount: string | null; contact_id: string | null; company_id: string | null;
    created_at: Date; priced_at: Date | null; reserved_at: Date | null; sold_at: Date | null; lost_at: Date | null; delivered_at: Date | null;
    outcome: 'won' | 'lost' | 'zombie'; closed_at: Date; is_repeat_hist: boolean; rn: string; total_closed: string;
  }>(
    `WITH z AS (SELECT * FROM unnest($2::text[], $3::int[]) AS t(head_group_name, days)),
     d AS (
       SELECT d.current_manager_id AS manager_id, d.deal_id, d.head_group_name, d.funnel_id, d.amount, d.contact_id, d.company_id,
              d.created_at, d.reserved_at, d.sold_at, d.lost_at, d.delivered_at,
              coalesce(z.days, $4::int) AS zdays
         FROM sa.deals d LEFT JOIN z ON z.head_group_name = d.head_group_name
        WHERE d.current_manager_id = ANY($1::bigint[]) AND d.funnel_id IN (0, 1, 2, 3)
     ),
     c AS (
       SELECT *, CASE WHEN sold_at IS NOT NULL THEN 'won' WHEN lost_at IS NOT NULL THEN 'lost'
                      WHEN reserved_at IS NULL AND created_at + make_interval(days => zdays) < now() THEN 'zombie' END AS outcome,
                 CASE WHEN sold_at IS NOT NULL THEN sold_at WHEN lost_at IS NOT NULL THEN lost_at ELSE created_at + make_interval(days => zdays) END AS closed_at
         FROM d
     ),
     ranked AS (
       SELECT *, row_number() OVER (PARTITION BY manager_id ORDER BY closed_at DESC) AS rn, count(*) OVER (PARTITION BY manager_id) AS total_closed
         FROM c WHERE outcome IS NOT NULL
     ),
     win AS (SELECT * FROM ranked WHERE rn <= $6),
     pe AS (SELECT e.deal_id, min(e.event_at) AS priced_at FROM sa.deal_events e JOIN win ON win.deal_id = e.deal_id WHERE e.stage_id = ANY($5::text[]) GROUP BY e.deal_id),
     fc AS (SELECT p.contact_id, min(p.delivered_at) AS first_deliv FROM sa.deals p WHERE p.delivered_at IS NOT NULL AND p.contact_id IN (SELECT DISTINCT contact_id FROM win WHERE contact_id IS NOT NULL) GROUP BY p.contact_id),
     fk AS (SELECT p.company_id, min(p.delivered_at) AS first_deliv FROM sa.deals p WHERE p.delivered_at IS NOT NULL AND p.company_id IN (SELECT DISTINCT company_id FROM win WHERE company_id IS NOT NULL AND company_id <> 0) GROUP BY p.company_id)
     SELECT win.manager_id::text AS manager_id, win.deal_id::text AS deal_id, win.head_group_name, win.funnel_id, win.amount::text AS amount, win.contact_id::text AS contact_id, win.company_id::text AS company_id,
            win.created_at, pe.priced_at, win.reserved_at, win.sold_at, win.lost_at, win.delivered_at, win.outcome, win.closed_at, win.rn::text AS rn, win.total_closed::text AS total_closed,
            CASE WHEN win.funnel_id IN (0, 2) THEN coalesce(fc.first_deliv < win.created_at, false)
                 ELSE coalesce(fk.first_deliv < win.created_at, fc.first_deliv < win.created_at, false) END AS is_repeat_hist
       FROM win LEFT JOIN pe ON pe.deal_id = win.deal_id
       LEFT JOIN fc ON fc.contact_id = win.contact_id
       LEFT JOIN fk ON fk.company_id = win.company_id AND win.company_id <> 0`,
    [managerIds, z.groups, z.days, z.fallback, hasPrice, N * 2],
  );
  timings.deals = deals.ms;

  const dealIds = deals.rows.map(r => r.deal_id);
  const calls = dealIds.length ? await saQuery<{ deal_id: string; called_at: Date; result: string | null; direction: string | null }>(
    `SELECT deal_id::text, called_at, result::text, direction::text FROM va.calls WHERE deal_id = ANY($1::bigint[]) AND called_at >= $2::date`,
    [dealIds, s.callsDataStart]) : { rows: [] as { deal_id: string; called_at: Date; result: string | null; direction: string | null }[], ms: 0 };
  timings.calls = calls.ms;
  const callsByDeal = new Map<string, { at: Date; completed: boolean; outbound: boolean }[]>();
  for (const c of calls.rows) (callsByDeal.get(c.deal_id) ?? callsByDeal.set(c.deal_id, []).get(c.deal_id)!).push({ at: new Date(c.called_at), completed: c.result === 'completed', outbound: c.direction === 'outbound' });

  // Открытые сделки: всего / зомби / «тишина» (без звонка ≥7 дней при возрасте ≥7).
  const open = await saQuery<{ manager_id: string; total: string; zombie: string; silence7: string }>(
    `WITH z AS (SELECT * FROM unnest($2::text[], $3::int[]) AS t(head_group_name, days)),
     o AS (
       SELECT d.current_manager_id AS manager_id, d.deal_id, d.created_at, (d.reserved_at IS NULL AND d.created_at + make_interval(days => coalesce(z.days, $4::int)) < now()) AS is_zombie
         FROM sa.deals d LEFT JOIN z ON z.head_group_name = d.head_group_name
        WHERE d.current_manager_id = ANY($1::bigint[]) AND d.funnel_id IN (0, 1, 2, 3) AND d.sold_at IS NULL AND d.lost_at IS NULL
     ),
     lc AS (SELECT c.deal_id, max(c.called_at) AS last_call FROM va.calls c JOIN o ON o.deal_id = c.deal_id GROUP BY c.deal_id)
     SELECT o.manager_id::text AS manager_id, count(*)::text AS total, count(*) FILTER (WHERE o.is_zombie)::text AS zombie,
            count(*) FILTER (WHERE o.created_at < now() - interval '7 days' AND coalesce(lc.last_call, o.created_at) < now() - interval '7 days')::text AS silence7
       FROM o LEFT JOIN lc ON lc.deal_id = o.deal_id GROUP BY 1`, [managerIds, z.groups, z.days, z.fallback]);
  timings.open = open.ms;
  const openBy = new Map(open.rows.map(r => [Number(r.manager_id), { total: Number(r.total), zombie: Number(r.zombie), silence7: Number(r.silence7) }]));

  const now = new Date();
  for (const id of managerIds) out.set(id, { managerId: id, current: [], previous: [], openDeals: openBy.get(id) ?? { total: 0, zombie: 0, silence7: 0 }, tickNo: 0 });
  for (const r of deals.rows) {
    const w = out.get(Number(r.manager_id))!;
    w.tickNo = Math.floor(Number(r.total_closed) / s.tickSize);
    const dc = callsByDeal.get(r.deal_id) ?? [];
    const firstCompleted = dc.filter(c => c.completed && c.at >= new Date(r.created_at)).sort((a, b) => a.at.getTime() - b.at.getTime())[0]?.at ?? null;
    let booking: boolean | null = null;
    if (r.reserved_at) {
      const nwd = nextWorkingDay(mskDay(new Date(r.reserved_at)));
      const ws = new Date(`${nwd}T00:00:00+03:00`), we = new Date(`${nwd}T23:59:59.999+03:00`);
      booking = we > now ? null : dc.some(c => c.outbound && c.at >= ws && c.at <= we);
    }
    const deal: WindowDeal = {
      dealId: r.deal_id, headGroup: r.head_group_name ?? '∅', funnelId: r.funnel_id, isRepeatHist: r.is_repeat_hist, amount: Number(r.amount ?? 0),
      createdAt: new Date(r.created_at), pricedAt: r.priced_at ? new Date(r.priced_at) : null, reservedAt: r.reserved_at ? new Date(r.reserved_at) : null,
      soldAt: r.sold_at ? new Date(r.sold_at) : null, lostAt: r.lost_at ? new Date(r.lost_at) : null, deliveredAt: r.delivered_at ? new Date(r.delivered_at) : null,
      outcome: r.outcome, closedAt: new Date(r.closed_at), calls: dc.length, firstCompletedCallAt: firstCompleted, bookingCalledNextDay: booking,
    };
    (Number(r.rn) <= N ? w.current : w.previous).push(deal);
  }
  console.log(`[diag] окна: менеджеров ${managerIds.length}, сделок ${deals.rows.length}, звонков ${calls.rows.length}; мс: ${JSON.stringify(timings)}`);
  lastWindowTimings = timings;
  return out;
}
export let lastWindowTimings: Record<string, number> = {};

// ── Значения тиковых узлов из набора сделок ──────────────────────────────────
const share = (num: number, den: number): NodeValue => ({ value: den ? (num / den) * 100 : null, n: den, kind: 'share' });
const median = (xs: number[]): NodeValue => { if (!xs.length) return { value: null, n: 0, kind: 'mean' }; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return { value: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2, n: s.length, kind: 'mean' }; };
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3600000;

/** Узлы дерева, вычислимые из окна закрытых сделок (deals — текущее или предыдущее окно). */
export function computeTickNodes(deals: WindowDeal[], open: ManagerWindow['openDeals']): Record<string, NodeValue> {
  const primary = deals.filter(d => !d.isRepeatHist), repeat = deals.filter(d => d.isRepeatHist);
  const won = (xs: WindowDeal[]) => xs.filter(d => d.outcome === 'won').length;
  const priced = primary.filter(d => d.pricedAt), reserved = primary.filter(d => d.reservedAt);
  const bookingKnown = deals.filter(d => d.bookingCalledNextDay !== null);
  return {
    cr_deal_to_sale:            share(won(primary), primary.length),
    cr_deal_to_sale_repeat:     share(won(repeat), repeat.length),
    cr_deal_to_priced:          share(priced.length, primary.length),
    cr_priced_to_reservation:   share(reserved.filter(d => d.pricedAt).length, priced.length),
    cr_reservation_to_sale:     share(won(reserved), reserved.length),
    booking_call_rate_reserved: share(bookingKnown.filter(d => d.bookingCalledNextDay).length, bookingKnown.length),
    calls_deals_no_call:        share(primary.filter(d => d.calls === 0).length, primary.length),
    calls_to_reservation_avg:   { value: reserved.length ? reserved.reduce((s, d) => s + d.calls, 0) / reserved.length : null, n: reserved.length, kind: 'mean' },
    calls_touch_speed_median:   median(primary.filter(d => d.firstCompletedCallAt).map(d => hours(d.createdAt, d.firstCompletedCallAt!) * 60)),
    price_speed_median_hours:   median(priced.map(d => hours(d.createdAt, d.pricedAt!))),
    multi_group_order_share:    { value: null, n: 0, kind: 'share' }, // нужны позиции заказа — следующий шаг
    zombie_share:               share(open.zombie, open.total),
    zombie_count:               { value: open.zombie, n: open.total, kind: 'count' },
    calls_silence_deals:        { value: open.silence7, n: open.total, kind: 'count' },
  };
}
