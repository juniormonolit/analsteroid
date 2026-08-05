// Три награды пула «Планёрка» (одобрены Серёгой 01.08):
//  * «Дисциплина броней» (planning_discipline, 30, ЕЖЕНЕДЕЛЬНАЯ) — календарная
//    неделя, где ВСЕ активные брони менеджера (reserved_at ИЛИ confirmed_at в
//    неделе, атрибуция current_manager_id) получили ХОТЯ БЫ ОДИН исходящий
//    звонок в течение 7 дней от вехи (va.calls, direction='outbound'). Проверяемо
//    по va.calls — данные звонков есть с CALLS_DATA_START (30.03.2026), поэтому
//    РЕТРО с первой полной недели после этой даты ЧЕСТНОЕ (не имитация, реальные
//    звонки за весь сезон); неделя учитывается только если её 7-дневные окна
//    ВСЕ уже закрылись (последний возможный срок звонка < сейчас) — иначе штраф
//    за не наступивший срок. Менеджер без броней на неделе — не участвует
//    (нечего проверять, не «молчаливый провал»).
//  * «Камбэк» (comeback, 75, МЕСЯЧНАЯ, ретро) — месяц M, где сумма продаж
//    (sold_at) ВЫРОСЛА к месяцу M-1, А сам месяц M-1 был ПАДЕНИЕМ к M-2:
//    sum(M) > sum(M-1) AND sum(M-1) < sum(M-2). Нужно 3 последовательных месяца
//    с данными (RETRO_START..текущий, ЗАКРЫТЫЕ месяцы).
//  * «Досрочник» (early_bird, 150, МЕСЯЧНАЯ, ретро) — план месяца (manager_plans,
//    поле plan_shipments — план ОТГРУЗОК, единственный план в системе) выполнен
//    К 20-МУ ЧИСЛУ включительно: Σ amount отгрузок (delivered_at) менеджера с
//    начала месяца по 20-е >= plan_shipments месяца. Ретро — по всем месяцам,
//    где в manager_plans есть строка для логина менеджера.
//
// Начисление — в общем ночном пересчёте (runBadgeRecompute), тот же идемпотентный
// путь через badge_awards UNIQUE (bitrix_id, badge_key, tier, period_type, period_date).

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { CALLS_DATA_START } from '@/features/reports/engine/callsMetrics';
import type { BadgeTier } from './catalog';

export interface PlanningAwardRow {
  bitrixId: number; badgeKey: string; tier: BadgeTier | null;
  periodType: 'day' | 'week' | 'month' | 'year' | null; periodDate: string | null;
  value: number | null; counter?: boolean;
}

const DAY_MS = 86_400_000;

function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// ── «Дисциплина броней» ───────────────────────────────────────────────────────

interface BookingMilestoneRow { deal_id: number; manager_id: number | null; at: Date }

export async function computeDisciplineAwards(todayYmd: string): Promise<PlanningAwardRow[]> {
  const firstMonday = mondayOf(CALLS_DATA_START);
  const now = Date.now();
  const out: PlanningAwardRow[] = [];

  for (let weekStart = firstMonday; ; weekStart = addDaysStr(weekStart, 7)) {
    const weekEnd = addDaysStr(weekStart, 6); // воскресенье той же недели
    // Неделя учитывается только когда ПОСЛЕДНИЙ возможный срок звонка (воскресенье
    // недели + 7 дней, конец суток) уже прошёл — иначе штрафуем за не наступивший срок.
    const deadline = new Date(`${addDaysStr(weekEnd, 7)}T23:59:59.999+03:00`).getTime();
    if (deadline > now) break;
    if (weekStart > todayYmd) break;

    const res = await analyticsDb().query<BookingMilestoneRow>(
      `SELECT deal_id, current_manager_id AS manager_id, reserved_at AS at FROM sa.deals
       WHERE current_manager_id IS NOT NULL AND reserved_at >= ($1||'T00:00:00+03:00')::timestamptz
         AND reserved_at < (($2||'T00:00:00+03:00')::timestamptz + interval '1 day')
       UNION ALL
       SELECT deal_id, current_manager_id AS manager_id, confirmed_at AS at FROM sa.deals
       WHERE current_manager_id IS NOT NULL AND confirmed_at >= ($1||'T00:00:00+03:00')::timestamptz
         AND confirmed_at < (($2||'T00:00:00+03:00')::timestamptz + interval '1 day')`,
      [weekStart, weekEnd],
    );
    if (res.rows.length === 0) continue;

    const dealIds = [...new Set(res.rows.map(r => r.deal_id))];
    const calls = await analyticsDb().query<{ deal_id: string; called_at: Date }>(
      `SELECT deal_id, called_at FROM va.calls WHERE deal_id = ANY($1) AND direction::text = 'outbound'`,
      [dealIds],
    );
    const callsByDeal = new Map<string, Date[]>();
    for (const c of calls.rows) {
      const k = String(c.deal_id);
      const arr = callsByDeal.get(k); if (arr) arr.push(new Date(c.called_at)); else callsByDeal.set(k, [new Date(c.called_at)]);
    }

    const byManager = new Map<number, boolean>(); // true = пока все ок
    const hasBooking = new Set<number>();
    for (const r of res.rows) {
      if (r.manager_id === null) continue;
      hasBooking.add(r.manager_id);
      const at = new Date(r.at).getTime();
      const called = (callsByDeal.get(String(r.deal_id)) ?? []).some(t => t.getTime() - at <= 7 * DAY_MS && t.getTime() >= at - DAY_MS);
      const cur = byManager.get(r.manager_id) ?? true;
      byManager.set(r.manager_id, cur && called);
    }
    // Правило релевантной выборки (решение владельца 05.08): «ВСЕ брони
    // прозвонены» при одной брони за неделю — не дисциплина. Живой случай:
    // менеджер с 24 бронями за всю историю (1-2 в неделю) собрал 5 наград.
    // Требуем минимальный объём броней за неделю.
    const bookingsByMgr = new Map<number, number>();
    for (const r of res.rows) {
      if (r.manager_id === null) continue;
      bookingsByMgr.set(r.manager_id, (bookingsByMgr.get(r.manager_id) ?? 0) + 1);
    }
    for (const mgr of hasBooking) {
      if ((bookingsByMgr.get(mgr) ?? 0) < MIN_BOOKINGS_FOR_DISCIPLINE) continue;
      if (byManager.get(mgr)) {
        out.push({ bitrixId: mgr, badgeKey: 'planning_discipline', tier: null, periodType: 'week', periodDate: weekStart, value: null });
      }
    }
  }
  return out;
}

// ── «Камбэк» ───────────────────────────────────────────────────────────────────

export async function computeComebackAwards(todayYmd: string, retroStart: string): Promise<PlanningAwardRow[]> {
  const res = await analyticsDb().query<{ mgr: number; ym: string; sum: string; cnt: string }>(
    `SELECT current_manager_id AS mgr, to_char(sold_at, 'YYYY-MM') AS ym, sum(amount) AS sum, count(*) AS cnt
     FROM sa.deals WHERE current_manager_id IS NOT NULL AND sold_at >= $1
     GROUP BY 1, 2`,
    [retroStart],
  );
  const byMgr = new Map<number, Map<string, { sum: number; cnt: number }>>();
  for (const r of res.rows) {
    const m = byMgr.get(r.mgr) ?? new Map<string, { sum: number; cnt: number }>();
    m.set(r.ym, { sum: Number(r.sum), cnt: Number(r.cnt) }); byMgr.set(r.mgr, m);
  }
  const thisMonth = todayYmd.slice(0, 7);
  const out: PlanningAwardRow[] = [];
  for (const [mgr, months] of byMgr) {
    const sorted = [...months.keys()].sort();
    for (let i = 2; i < sorted.length; i++) {
      const m2 = sorted[i]; // текущий месяц-кандидат M
      if (m2 >= thisMonth) continue; // только ЗАКРЫТЫЕ месяцы
      const m1 = sorted[i - 1], m0 = sorted[i - 2];
      // Последовательные месяцы без разрыва (иначе "падение" не сравнимо честно)
      if (nextMonth(m0) !== m1 || nextMonth(m1) !== m2) continue;
      const rM = months.get(m2)!, rM1 = months.get(m1)!, rM0 = months.get(m0)!;
      // Правило релевантной выборки (05.08): «спад → рост» на одной сделке в
      // месяц (100 → 50 → 200 ₽) — не камбэк. Каждый из трёх месяцев обязан
      // быть представительным по числу сделок.
      if (rM.cnt < MIN_DEALS_PER_MONTH_FOR_COMEBACK || rM1.cnt < MIN_DEALS_PER_MONTH_FOR_COMEBACK
        || rM0.cnt < MIN_DEALS_PER_MONTH_FOR_COMEBACK) continue;
      const sM = rM.sum, sM1 = rM1.sum, sM0 = rM0.sum;
      if (sM1 < sM0 && sM > sM1) {
        out.push({ bitrixId: mgr, badgeKey: 'comeback', tier: null, periodType: 'month', periodDate: `${m2}-01`, value: null });
      }
    }
  }
  return out;
}

// ── «Досрочник» ─────────────────────────────────────────────────────────────

interface PlanRow { manager_login: string; month: string; plan_shipments: string }

// Пороги релевантной выборки (решение владельца 05.08). Вынесены константами:
// движок читает их напрямую, у этих бейджей нет criteria-настроек в каталоге.
const MIN_BOOKINGS_FOR_DISCIPLINE = 3;
const MIN_DEALS_PER_MONTH_FOR_COMEBACK = 3;

export async function computeEarlyBirdAwards(todayYmd: string): Promise<PlanningAwardRow[]> {
  const plans = await systemDb().query<PlanRow>(
    `SELECT manager_login, to_char(month, 'YYYY-MM') AS month, plan_shipments FROM manager_plans`,
  );
  if (plans.rows.length === 0) return [];
  const thisMonth = todayYmd.slice(0, 7);
  // только месяцы, у которых 20-е число уже наступило (закрытый порог)
  // Правило релевантной выборки (05.08): план 0 делает условие «отгрузил план
  // до 20-го» вакуумно истинным — «Досрочник» падал всем, у кого просто стоит
  // нулевая строка плана (РОПы, снабженцы). Нулевые/пустые планы отбрасываем.
  const eligible = plans.rows.filter(p => {
    const day20 = `${p.month}-20`;
    return day20 <= todayYmd && Number(p.plan_shipments) > 0;
  });
  if (eligible.length === 0) return [];

  const loginsRes = await analyticsDb().query<{ short_login: string; manager_bitrix_user_id: string }>(
    `SELECT short_login, manager_bitrix_user_id FROM sa.org_resolved_hierarchy WHERE short_login IS NOT NULL`,
  );
  const bitrixByLogin = new Map(loginsRes.rows.map(r => [r.short_login, Number(r.manager_bitrix_user_id)]));

  const out: PlanningAwardRow[] = [];
  for (const p of eligible) {
    const bitrixId = bitrixByLogin.get(p.manager_login);
    if (!bitrixId) continue;
    const monthStart = `${p.month}-01`;
    const day20 = `${p.month}-20`;
    const shipRes = await analyticsDb().query<{ sum: string | null }>(
      `SELECT COALESCE(sum(amount), 0) AS sum FROM sa.deals
       WHERE current_manager_id = $1 AND delivered_at >= ($2||'T00:00:00+03:00')::timestamptz
         AND delivered_at < (($3||'T00:00:00+03:00')::timestamptz + interval '1 day')`,
      [bitrixId, monthStart, day20],
    );
    const shipped = Number(shipRes.rows[0]?.sum ?? 0);
    if (Number(p.plan_shipments) > 0 && shipped >= Number(p.plan_shipments)) {
      out.push({ bitrixId, badgeKey: 'early_bird', tier: null, periodType: 'month', periodDate: monthStart, value: null });
    }
  }
  return out;
}

export async function computePlanningBadgeAwards(todayYmd: string, retroStart: string): Promise<PlanningAwardRow[]> {
  const [discipline, comeback, earlyBird] = await Promise.all([
    computeDisciplineAwards(todayYmd),
    computeComebackAwards(todayYmd, retroStart),
    computeEarlyBirdAwards(todayYmd),
  ]);
  return [...discipline, ...comeback, ...earlyBird];
}
