import 'server-only';
import { analyticsDb } from '@/lib/db/clients';
import { leaderTitleForLevel } from '@/features/xp/engine/xp';

// Скиллы РУКОВОДИТЕЛЯ (решение владельца 05.08: «у РОПов и директоров должны
// быть скиллы не по материалам как у менеджеров, а по показателям их отдела:
// Бронирование, Первичная конверсия, Повторные продажи (доля), Сумма отгрузок,
// ну и из этого состоит уровень»).
//
// КАК СЧИТАЕМ УРОВЕНЬ. Абсолютные пороги («каждые N броней — уровень») пришлось
// бы вечно подкручивать руками и они врали бы при разном размере отделов.
// Поэтому уровень — ПЕРЦЕНТИЛЬ отдела среди всех отделов компании за окно 90
// дней: шкала самокалибруется, растёт только реальным улучшением ОТНОСИТЕЛЬНО
// остальных. Кривая p^1.4 подобрана так, чтобы медианный отдел давал ≈10 —
// ступень «Локомотив», которую владелец назвал «промежуточной, как ветеран у
// продажников»; топ упирается в 30 («Атомный ледокол»).
//
// Четыре скилла — ровно те, что назвал владелец. Порядок сохранён.

const WINDOW_DAYS = 90;
const MAX_LEVEL = 30;

export interface LeaderSkill {
  key: 'bookings' | 'primary_cr' | 'repeat_share' | 'shipments';
  label: string;
  /** Сырое значение отдела за окно (для подписи). */
  value: number;
  unit: 'count' | 'percent' | 'money';
  /** 0..100 — место среди отделов. */
  percentile: number;
  level: number;
}

export interface LeaderSkillsResult {
  level: number;
  title: string;
  skills: LeaderSkill[];
  deptCount: number;
  windowDays: number;
  /** Отделы, по которым считали (у директора их несколько). */
  scopeDepts: number;
}

interface DeptRow {
  did: string; bookings: string; prim_sold: string; prim_all: string;
  repeat_amt: string; sold_amt: string; ship_amt: string;
}

const levelFromPercentile = (p: number) => Math.max(0, Math.min(MAX_LEVEL, Math.round(Math.pow(p / 100, 1.4) * MAX_LEVEL)));

/** Перцентиль значения среди массива (доля тех, кто строго ниже). */
function percentileOf(value: number, all: number[]): number {
  if (all.length <= 1) return 50; // не с кем сравнивать — считаем средним
  const below = all.filter(v => v < value).length;
  return Math.round((below / (all.length - 1)) * 100);
}

export async function buildLeaderSkills(deptIds: string[]): Promise<LeaderSkillsResult | null> {
  if (deptIds.length === 0) return null;

  // Одним запросом — ВСЕ отделы (нужны для перцентиля), окно 90 дней.
  const res = await analyticsDb().query<DeptRow>(
    `WITH win AS (SELECT (now() - ($1 || ' days')::interval) AS f),
     base AS (
       SELECT h.department_id::text did, d.reserved_at, d.sold_at, d.delivered_at, d.amount, f.is_repeat
         FROM sa.deals d
         JOIN sa.org_resolved_hierarchy h
           ON h.manager_bitrix_user_id::text = d.current_manager_id::text AND h.is_active
         LEFT JOIN sa.funnels f ON f.id = d.funnel_id
        WHERE h.department_id IS NOT NULL
          AND (d.created_at >= (SELECT f FROM win) OR d.sold_at >= (SELECT f FROM win)
               OR d.delivered_at >= (SELECT f FROM win))
     )
     SELECT did,
       count(*) FILTER (WHERE reserved_at IS NOT NULL)::text AS bookings,
       count(*) FILTER (WHERE sold_at IS NOT NULL AND is_repeat IS NOT TRUE)::text AS prim_sold,
       count(*) FILTER (WHERE is_repeat IS NOT TRUE)::text AS prim_all,
       COALESCE(sum(amount) FILTER (WHERE sold_at IS NOT NULL AND is_repeat), 0)::text AS repeat_amt,
       COALESCE(sum(amount) FILTER (WHERE sold_at IS NOT NULL), 0)::text AS sold_amt,
       COALESCE(sum(amount) FILTER (WHERE delivered_at IS NOT NULL), 0)::text AS ship_amt
     FROM base GROUP BY 1`,
    [String(WINDOW_DAYS)],
  );

  const metric = (r: DeptRow) => ({
    bookings: Number(r.bookings),
    primaryCr: Number(r.prim_all) > 0 ? (Number(r.prim_sold) / Number(r.prim_all)) * 100 : 0,
    repeatShare: Number(r.sold_amt) > 0 ? (Number(r.repeat_amt) / Number(r.sold_amt)) * 100 : 0,
    shipments: Number(r.ship_amt),
  });

  const all = res.rows.map(metric);
  if (all.length === 0) return null;

  // Свои отделы (у директора их несколько) — метрики складываем, доли считаем
  // от сложенных сумм, а не усредняем проценты (иначе маленький отдел весил бы
  // столько же, сколько большой).
  const mine = res.rows.filter(r => deptIds.includes(r.did));
  if (mine.length === 0) return null;
  const acc = mine.reduce((a, r) => ({
    bookings: a.bookings + Number(r.bookings),
    primSold: a.primSold + Number(r.prim_sold),
    primAll: a.primAll + Number(r.prim_all),
    repeatAmt: a.repeatAmt + Number(r.repeat_amt),
    soldAmt: a.soldAmt + Number(r.sold_amt),
    shipAmt: a.shipAmt + Number(r.ship_amt),
  }), { bookings: 0, primSold: 0, primAll: 0, repeatAmt: 0, soldAmt: 0, shipAmt: 0 });

  const mineMetrics = {
    bookings: acc.bookings,
    primaryCr: acc.primAll > 0 ? (acc.primSold / acc.primAll) * 100 : 0,
    repeatShare: acc.soldAmt > 0 ? (acc.repeatAmt / acc.soldAmt) * 100 : 0,
    shipments: acc.shipAmt,
  };

  // Отдел ВНЕ ПРОДАЖ (логистика, маркетинг, снабжение — по живым данным таких
  // 10 из 29) не должен получать «Дрезину» за отсутствие функции продаж: это не
  // слабый результат, а другой род занятий. Правило владельца — «где нет данных,
  // так и написать»: отдаём null, блок скиллов просто не рисуется.
  if (acc.bookings === 0 && acc.primAll === 0 && acc.soldAmt === 0 && acc.shipAmt === 0) return null;

  const skills: LeaderSkill[] = ([
    { key: 'bookings', label: 'Бронирование', unit: 'count', value: Math.round(mineMetrics.bookings),
      percentile: percentileOf(mineMetrics.bookings, all.map(m => m.bookings)), level: 0 },
    { key: 'primary_cr', label: 'Первичная конверсия', unit: 'percent', value: Math.round(mineMetrics.primaryCr * 10) / 10,
      percentile: percentileOf(mineMetrics.primaryCr, all.map(m => m.primaryCr)), level: 0 },
    { key: 'repeat_share', label: 'Повторные продажи', unit: 'percent', value: Math.round(mineMetrics.repeatShare * 10) / 10,
      percentile: percentileOf(mineMetrics.repeatShare, all.map(m => m.repeatShare)), level: 0 },
    { key: 'shipments', label: 'Сумма отгрузок', unit: 'money', value: Math.round(mineMetrics.shipments),
      percentile: percentileOf(mineMetrics.shipments, all.map(m => m.shipments)), level: 0 },
  ] as LeaderSkill[]).map(s => ({ ...s, level: levelFromPercentile(s.percentile) }));

  // Общий уровень руководителя — по СРЕДНЕМУ перцентилю четырёх скиллов
  // (а не по среднему уровней: усреднять уже искривлённое значит кривить дважды).
  const avgPercentile = skills.reduce((s, x) => s + x.percentile, 0) / skills.length;
  const level = levelFromPercentile(avgPercentile);

  return {
    level,
    title: leaderTitleForLevel(level),
    skills,
    deptCount: all.length,
    windowDays: WINDOW_DAYS,
    scopeDepts: mine.length,
  };
}
