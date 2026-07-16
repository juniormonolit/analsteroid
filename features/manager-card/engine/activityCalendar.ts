// «График работы» менеджера (задача Иосифа 16.07, «как у Claude Code»): плитки,
// календарь-хитмап и разбивка активности. Активность = звонки (va.calls) +
// изменения сделок (sa.deal_events, manager_id NOT NULL — проверено задачей 10.07
// про метрики активности). Всё по МСК-дням. Серии (streak) считаются ПО БУДНЯМ:
// выходные серию не рвут и не добавляют (менеджер не обязан звонить в субботу).

import { analyticsDb } from '@/lib/db/clients';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { formatInTimeZone } from 'date-fns-tz';

export interface ActivityDay {
  date: string; // YYYY-MM-DD (МСК)
  calls: number;
  deals: number; // изменённых сделок (distinct) за день
}

export interface ActivityBreakdownRow {
  key: 'calls_out' | 'calls_in' | 'deal_events';
  label: string;
  count: number;
  pct: number;
}

export interface ManagerActivityResult {
  days: ActivityDay[];
  tiles: {
    workDays: number;
    calls: number;
    dealsTouched: number;
    talkMinutes: number;
    currentStreak: number;
    longestStreak: number;
    peakHour: number | null;
    favoriteCategory: string | null;
  };
  breakdown: ActivityBreakdownRow[];
  /** «Активнее ~N% менеджеров» за то же окно (по звонки+события среди активных). */
  percentile: number | null;
  meta: { from: string; to: string };
}

const MSK = 'Europe/Moscow';

function mskDateStr(d: Date): string {
  return formatInTimeZone(d, MSK, 'yyyy-MM-dd');
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWeekend(dateStr: string): boolean {
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

export async function buildManagerActivity(managerId: string, windowDays: number): Promise<ManagerActivityResult> {
  const sa = analyticsDb();
  const todayStr = mskDateStr(new Date());
  const fromStr = addDays(todayStr, -(windowDays - 1));
  const fromTs = `${fromStr}T00:00:00+03:00`;
  const toTs = `${addDays(todayStr, 1)}T00:00:00+03:00`;

  const managerIdNum = /^\d+$/.test(managerId) ? Number(managerId) : null;

  const [callsRes, eventsRes, poolCallsRes, poolEventsRes, pgRows] = await Promise.all([
    sa.query<{ day: string; hour: number; direction: string | null; n: string; dur: string | null }>(
      `SELECT (called_at AT TIME ZONE '${MSK}')::date::text AS day,
              extract(hour FROM called_at AT TIME ZONE '${MSK}')::int AS hour,
              direction::text AS direction, count(*) AS n, sum(duration_seconds) AS dur
       FROM va.calls
       WHERE manager_id = $1 AND called_at >= $2::timestamptz AND called_at < $3::timestamptz
       GROUP BY 1, 2, 3`,
      [managerIdNum, fromTs, toTs],
    ),
    sa.query<{ day: string; hour: number; n: string; deals: string }>(
      `SELECT (event_at AT TIME ZONE '${MSK}')::date::text AS day,
              extract(hour FROM event_at AT TIME ZONE '${MSK}')::int AS hour,
              count(*) AS n, count(DISTINCT deal_id) AS deals
       FROM sa.deal_events
       WHERE manager_id::text = $1 AND event_at >= $2::timestamptz AND event_at < $3::timestamptz
       GROUP BY 1, 2`,
      [managerId, fromTs, toTs],
    ),
    // Пул для перцентиля «активнее N% менеджеров» — суммарная активность каждого.
    sa.query<{ manager_id: string; n: string }>(
      `SELECT manager_id::text AS manager_id, count(*) AS n
       FROM va.calls WHERE called_at >= $1::timestamptz AND called_at < $2::timestamptz AND manager_id IS NOT NULL
       GROUP BY 1`,
      [fromTs, toTs],
    ),
    sa.query<{ manager_id: string; n: string }>(
      `SELECT manager_id::text AS manager_id, count(*) AS n
       FROM sa.deal_events WHERE event_at >= $1::timestamptz AND event_at < $2::timestamptz AND manager_id IS NOT NULL
       GROUP BY 1`,
      [fromTs, toTs],
    ),
    // «Любимая категория» (аналог Favorite model): топ по сумме продаж за окно.
    fetchByProductGroups({
      period: { from: new Date(fromTs), to: new Date(`${todayStr}T23:59:59+03:00`) },
      dealScope: 'all', clientType: 'all', productGroupMode: 'kc', managerId,
    }).catch(() => []),
  ]);

  // ── Дни: календарная сетка окна (включая пустые дни) ────────────────────────
  const byDay = new Map<string, ActivityDay>();
  for (let d = fromStr; d <= todayStr; d = addDays(d, 1)) {
    byDay.set(d, { date: d, calls: 0, deals: 0 });
  }
  let callsOut = 0, callsIn = 0, talkSeconds = 0;
  const hourTotals = new Map<number, number>();
  for (const r of callsRes.rows) {
    const day = byDay.get(r.day);
    const n = Number(r.n);
    if (day) day.calls += n;
    if (r.direction === 'outbound') callsOut += n; else if (r.direction === 'inbound') callsIn += n;
    talkSeconds += Number(r.dur ?? 0);
    hourTotals.set(r.hour, (hourTotals.get(r.hour) ?? 0) + n);
  }
  let dealEventsTotal = 0;
  const dealsTouchedByDay = new Map<string, number>();
  for (const r of eventsRes.rows) {
    const day = byDay.get(r.day);
    const deals = Number(r.deals);
    if (day) day.deals = Math.max(day.deals, 0) + deals; // по часам distinct суммируем — верхняя оценка дня
    dealEventsTotal += Number(r.n);
    dealsTouchedByDay.set(r.day, (dealsTouchedByDay.get(r.day) ?? 0) + deals);
    hourTotals.set(r.hour, (hourTotals.get(r.hour) ?? 0) + Number(r.n));
  }
  const days = [...byDay.values()];

  // ── Плитки ───────────────────────────────────────────────────────────────────
  const activeSet = new Set(days.filter(d => d.calls > 0 || d.deals > 0).map(d => d.date));
  const workDays = activeSet.size;
  const callsTotal = callsOut + callsIn;

  // Серии по будням; «сегодня ещё не начал» серию не рвёт (старт со вчера).
  const streakFrom = (start: string): number => {
    let streak = 0;
    for (let d = start; d >= fromStr; d = addDays(d, -1)) {
      if (isWeekend(d)) continue;
      if (activeSet.has(d)) streak++;
      else break;
    }
    return streak;
  };
  const currentStreak = activeSet.has(todayStr) || isWeekend(todayStr)
    ? streakFrom(todayStr)
    : streakFrom(addDays(todayStr, -1));
  let longestStreak = 0, run = 0;
  for (let d = fromStr; d <= todayStr; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    if (activeSet.has(d)) { run++; longestStreak = Math.max(longestStreak, run); }
    else run = 0;
  }

  let peakHour: number | null = null, peakN = 0;
  for (const [h, n] of hourTotals) if (n > peakN) { peakN = n; peakHour = h; }

  const topCategory = pgRows
    .map(r => ({ name: r.dimensionName, amount: (r.metrics.primary_sales_amount ?? 0) + (r.metrics.repeat_sales_amount ?? 0) }))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0];

  // ── Разбивка (аналог списка моделей) ────────────────────────────────────────
  const totalActs = callsOut + callsIn + dealEventsTotal;
  const pct = (n: number) => totalActs > 0 ? Math.round((n / totalActs) * 1000) / 10 : 0;
  const breakdown: ActivityBreakdownRow[] = [
    { key: 'calls_out', label: 'Исходящие звонки', count: callsOut, pct: pct(callsOut) },
    { key: 'calls_in', label: 'Входящие звонки', count: callsIn, pct: pct(callsIn) },
    { key: 'deal_events', label: 'Изменения сделок', count: dealEventsTotal, pct: pct(dealEventsTotal) },
  ];

  // ── Перцентиль среди активных менеджеров ─────────────────────────────────────
  const totals = new Map<string, number>();
  for (const r of poolCallsRes.rows) totals.set(r.manager_id, (totals.get(r.manager_id) ?? 0) + Number(r.n));
  for (const r of poolEventsRes.rows) totals.set(r.manager_id, (totals.get(r.manager_id) ?? 0) + Number(r.n));
  const mine = totals.get(managerId) ?? 0;
  const pool = [...totals.values()].filter(v => v > 0);
  const percentile = mine > 0 && pool.length > 1
    ? Math.round((pool.filter(v => v < mine).length / pool.length) * 100)
    : null;

  // deals в плитке — сумма по дням distinct-сделок (за день без дублей; между днями
  // одна сделка может считаться повторно — это «касания по дням», как active days).
  const dealsTouched = [...dealsTouchedByDay.values()].reduce((a, b) => a + b, 0);

  return {
    days,
    tiles: {
      workDays,
      calls: callsTotal,
      dealsTouched,
      talkMinutes: Math.round(talkSeconds / 60),
      currentStreak,
      longestStreak,
      peakHour,
      favoriteCategory: topCategory?.name ?? null,
    },
    breakdown,
    percentile,
    meta: { from: fromStr, to: todayStr },
  };
}
