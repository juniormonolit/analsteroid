import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { CLIENT_KEY_CASE_SQL } from './clientKey';
import { REPEAT_WINDOW_DAYS, GOOD_CALL_MIN_SEC, AUTO_REPEAT_DEAL_WINDOW_MIN } from './customers';
import { fetchLastContactsInRange } from './contactsRange';

// ── Шапка «Моих заказчиков»: метрики менеджера по повторным продажам (17.09) ──
// Пять чисел за текущий месяц с трендом к прошлому:
//   coverage   — охват окна: доля отгрузок, по которым был успешный звонок (или
//                отметка «Связался») в первые 22 дня. Знаменатель — отгрузки, у
//                которых окно уже закрылось ИЛИ контакт уже был: открытые окна без
//                звонка ещё не провал;
//   ppoCr      — конверсия ППО: доля авто-сделок повторки (создана процессом в
//                первые 15 минут после отгрузки), дошедших до продажи;
//   repeatShare— доля повторных воронок (2, 3) в сумме продаж месяца;
//   dumped     — «слито без звонка»: доля авто-сделок, закрытых в отказ без
//                успешного звонка (в подсказке — закрытые за 5 минут);
//   callDay    — медианный день первого успешного звонка после отгрузки.

export interface RepeatMonth {
  from: string; to: string;           // YYYY-MM-DD (МСК), to — исключительно
  deliveries: number;
  windowsClosed: number;              // знаменатель охвата
  covered: number;
  coveragePct: number | null;
  autoDeals: number;
  autoSold: number;
  autoLost: number;
  autoLostNoCall: number;
  autoLost5min: number;
  ppoCrPct: number | null;
  dumpedPct: number | null;
  soldSum: number;
  repeatSoldSum: number;
  repeatSharePct: number | null;
  callDayMedian: number | null;
}
export interface RepeatHeader { current: RepeatMonth; previous: RepeatMonth }

function mskMonthBounds(offset: number): { from: string; to: string } {
  const now = new Date(Date.now() + 3 * 3600_000);
  const y = now.getUTCFullYear(); const m = now.getUTCMonth() + offset;
  const a = new Date(Date.UTC(y, m, 1)); const b = new Date(Date.UTC(y, m + 1, 1));
  return { from: a.toISOString().slice(0, 10), to: b.toISOString().slice(0, 10) };
}
const mskTs = (ymd: string) => `${ymd}T00:00:00+03:00`;

interface DelRow { deal_id: string; client_key: string; delivered_at: Date; first_call_at: Date | null }
interface AutoRow { auto_deals: string; auto_sold: string; auto_lost: string; auto_lost_no_call: string; auto_lost_5min: string; sold_sum: string; repeat_sold_sum: string }

async function monthMetrics(managerId: number, from: string, to: string): Promise<RepeatMonth> {
  const db = analyticsDb();
  const [del, auto, contacts] = await Promise.all([
    db.query<DelRow>(`
WITH d AS (
  SELECT d.deal_id, d.delivered_at, (${CLIENT_KEY_CASE_SQL}) AS client_key
    FROM sa.deals d
   WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3)
     AND d.delivered_at >= $2::timestamptz AND d.delivered_at < $3::timestamptz
)
SELECT d.deal_id::text, d.client_key, d.delivered_at,
       (SELECT min(c.called_at) FROM va.calls c
          JOIN sa.deals x ON x.deal_id = c.deal_id
         WHERE (${CLIENT_KEY_CASE_SQL.replace(/\bd\./g, 'x.')}) = d.client_key
           AND c.duration_seconds > ${GOOD_CALL_MIN_SEC}
           AND c.called_at > d.delivered_at
           AND c.called_at < d.delivered_at + interval '${REPEAT_WINDOW_DAYS} days') AS first_call_at
  FROM d WHERE d.client_key IS NOT NULL`, [managerId, mskTs(from), mskTs(to)]),
    db.query<AutoRow>(`
WITH rep AS (
  SELECT r.deal_id, r.created_at, r.lost_at, r.sold_at, (${CLIENT_KEY_CASE_SQL.replace(/\bd\./g, 'r.')}) AS client_key
    FROM sa.deals r
   WHERE r.current_manager_id = $1 AND r.funnel_id IN (2,3)
     AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz
),
auto AS (
  SELECT DISTINCT r.* FROM rep r
   WHERE EXISTS (SELECT 1 FROM sa.deals p
                  WHERE p.deal_id <> r.deal_id AND p.delivered_at IS NOT NULL AND p.funnel_id IN (0,1,2,3)
                    AND (${CLIENT_KEY_CASE_SQL.replace(/\bd\./g, 'p.')}) = r.client_key
                    AND r.created_at BETWEEN p.delivered_at - interval '1 minute' AND p.delivered_at + interval '${AUTO_REPEAT_DEAL_WINDOW_MIN} minutes')
),
gc AS (SELECT a.deal_id, bool_or(c.duration_seconds > ${GOOD_CALL_MIN_SEC}) AS good FROM auto a JOIN va.calls c ON c.deal_id = a.deal_id GROUP BY 1),
sold AS (
  SELECT coalesce(sum(amount::numeric), 0) AS sold_sum,
         coalesce(sum(amount::numeric) FILTER (WHERE funnel_id IN (2,3)), 0) AS repeat_sold_sum
    FROM sa.deals WHERE current_manager_id = $1 AND funnel_id IN (0,1,2,3)
     AND sold_at >= $2::timestamptz AND sold_at < $3::timestamptz AND amount::numeric BETWEEN 0 AND 50000000
)
SELECT (SELECT count(*) FROM auto)::text AS auto_deals,
       (SELECT count(*) FROM auto WHERE sold_at IS NOT NULL)::text AS auto_sold,
       (SELECT count(*) FROM auto WHERE lost_at IS NOT NULL)::text AS auto_lost,
       (SELECT count(*) FROM auto a LEFT JOIN gc USING (deal_id) WHERE a.lost_at IS NOT NULL AND NOT coalesce(gc.good, false))::text AS auto_lost_no_call,
       (SELECT count(*) FROM auto WHERE lost_at IS NOT NULL AND lost_at < created_at + interval '5 minutes')::text AS auto_lost_5min,
       sold_sum::text, repeat_sold_sum::text
  FROM sold`, [managerId, mskTs(from), mskTs(to)]),
    fetchLastContactsInRange(String(managerId), mskTs(from)),
  ]);

  const now = Date.now();
  let windowsClosed = 0, covered = 0; const callDays: number[] = [];
  for (const r of del.rows) {
    const delMs = new Date(r.delivered_at).getTime();
    const callMs = r.first_call_at ? new Date(r.first_call_at).getTime() : null;
    const manual = contacts.get(r.client_key)?.find(t => t > delMs && t < delMs + REPEAT_WINDOW_DAYS * 86_400_000) ?? null;
    const contactMs = callMs ?? manual;
    const closed = now > delMs + REPEAT_WINDOW_DAYS * 86_400_000;
    if (contactMs !== null || closed) windowsClosed++;
    if (contactMs !== null) { covered++; callDays.push((contactMs - delMs) / 86_400_000); }
  }
  callDays.sort((a, b) => a - b);
  const a = auto.rows[0];
  const n = (v: string | undefined) => Number(v ?? 0);
  const pct = (x: number, y: number) => (y > 0 ? Math.round((x / y) * 1000) / 10 : null);
  return {
    from, to,
    deliveries: del.rows.length, windowsClosed, covered, coveragePct: pct(covered, windowsClosed),
    autoDeals: n(a?.auto_deals), autoSold: n(a?.auto_sold), autoLost: n(a?.auto_lost),
    autoLostNoCall: n(a?.auto_lost_no_call), autoLost5min: n(a?.auto_lost_5min),
    ppoCrPct: pct(n(a?.auto_sold), n(a?.auto_deals)),
    dumpedPct: pct(n(a?.auto_lost_no_call), n(a?.auto_deals)),
    soldSum: Math.round(n(a?.sold_sum)), repeatSoldSum: Math.round(n(a?.repeat_sold_sum)),
    repeatSharePct: pct(n(a?.repeat_sold_sum), n(a?.sold_sum)),
    callDayMedian: callDays.length ? Math.round(callDays[Math.floor(callDays.length / 2)] * 10) / 10 : null,
  };
}

export async function fetchRepeatHeader(managerId: number): Promise<RepeatHeader> {
  return cached(`customers:header:v1:${managerId}`, 10 * 60, async () => {
    const cur = mskMonthBounds(0); const prev = mskMonthBounds(-1);
    const [current, previous] = await Promise.all([monthMetrics(managerId, cur.from, cur.to), monthMetrics(managerId, prev.from, prev.to)]);
    return { current, previous };
  });
}
