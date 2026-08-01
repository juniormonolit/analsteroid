// XP-система (фича Серёги 01.08, миграция 124): опыт как в MMORPG.
//
// Принципы:
//  * XP — репутация: только растёт, НЕ тратится, НЕ конвертируется в ебаллы;
//    хранится отдельно от кошельков (xp_ledger в системной БД).
//  * Начисление ТОЛЬКО за продажи/отгрузки (за звонки/брони XP нет).
//  * СЛОТ-МОДЕЛЬ: XP живёт с человеком, не с логином. Граница текущего
//    человека = sa.employee_registry.manual_start_date, а при её отсутствии —
//    valid_from текущего имени в sa.employee_name_history, но ТОЛЬКО если у
//    логина были переименования (одна сеющая строка от 13.07 переименованием
//    не считается — иначе всем срезало бы ретро). Без переименований граница —
//    дата первой сделки логина, что для XP эквивалентно отсутствию границы.
//    Сделки раньше границы в XP не попадают (XP прежнего человека «заморожен»).
//  * Формула («фикс — бОльшая часть», правка Серёги): продажа = sale_fix +
//    min(сумма/sale_per_rub, sale_sum_cap); отгрузка = ship_fix +
//    min(сумма/ship_per_rub, ship_sum_cap). Множители: повторная продажа
//    (funnel is_repeat) ×2, допродажа по рекомендации (следующая сделка клиента
//    в группе из топ-3 матрицы переходов) ×2 — множители НЕ стакуются, берётся
//    больший; скорость (рабочее время в WORK-стадиях до продажи < медианы
//    товарной группы, deal_events, только валидная история с 03.04.2026) —
//    отдельный бонус ×(1+speed_bonus) ПОВЕРХ. «Довёл до постоянника» (вторая
//    продажа клиента) = +regular_bonus без множителей.
//  * Ретро с 2025-01-01 (XP не зависит от deal_events — только sold_at/суммы;
//    скорость-бонус в ретро честно не даётся там, где историю не мерили).
//  * Полный идемпотентный пересчёт леджера каждым тиком (как badge_awards).
//
// Уровни: XP для уровня N = level_base × N^level_exp (дефолт 500 × N^1.5,
// проверено на ретро: медиана активных ≈ 8, топы 34–44). Классы — та же
// кривая с базой class_level_base по доменам головных групп (xp_class_map).

import type { Pool, PoolClient } from 'pg';
import { analyticsDb } from '@/lib/db/clients';
import { fetchCrossSellMatrix, recommendFor } from '@/features/customers/engine/crossSell';

const MSK = 'Europe/Moscow';
/** Ретро-старт XP-леджера (решение Серёги: вся история продаж с 2025). */
export const XP_RETRO_START = '2025-01-01';
/** Награды за XP-события (ебаллы) — только с ретро-старта наградной системы. */
const AWARD_RETRO_START = '2026-04-03';
/** Начало сбора deal_events — раньше скорость сделки не мерили. */
const DEAL_EVENTS_START = '2026-04-03';
/** Минимум наблюдений в группе для собственной медианы скорости. */
const SPEED_MIN_SAMPLE = 30;

export const OTHER_CLASS = 'Прочее';

export interface XpSettings {
  saleFix: number; salePerRub: number; saleSumCap: number;
  shipFix: number; shipPerRub: number; shipSumCap: number;
  repeatMult: number; crosssellMult: number; regularBonus: number;
  speedBonus: number;
  levelBase: number; levelExp: number; classLevelBase: number;
}

export async function loadXpSettings(db: Pool | PoolClient): Promise<XpSettings> {
  const r = await db.query<Record<string, string>>(`SELECT * FROM xp_settings WHERE id = 1`);
  const row = r.rows[0] ?? {};
  const n = (k: string, d: number) => (row[k] !== undefined && row[k] !== null ? Number(row[k]) : d);
  return {
    saleFix: n('sale_fix', 40), salePerRub: n('sale_per_rub', 10000), saleSumCap: n('sale_sum_cap', 60),
    shipFix: n('ship_fix', 20), shipPerRub: n('ship_per_rub', 20000), shipSumCap: n('ship_sum_cap', 30),
    repeatMult: n('repeat_mult', 2), crosssellMult: n('crosssell_mult', 2), regularBonus: n('regular_bonus', 50),
    speedBonus: n('speed_bonus', 0.25),
    levelBase: n('level_base', 500), levelExp: n('level_exp', 1.5), classLevelBase: n('class_level_base', 150),
  };
}

export async function loadClassMap(db: Pool | PoolClient): Promise<Map<string, string>> {
  const r = await db.query<{ head_group: string; class_name: string }>(
    `SELECT head_group, class_name FROM xp_class_map`,
  );
  return new Map(r.rows.map(x => [x.head_group, x.class_name]));
}

// ── уровни и титулы ──────────────────────────────────────────────────────────

export function xpForLevel(level: number, base: number, exp: number): number {
  return Math.round(base * Math.pow(level, exp));
}

export function levelFromXp(xp: number, base: number, exp: number): number {
  if (xp < base) return 0;
  let lvl = Math.floor(Math.pow(xp / base, 1 / exp));
  // защита от плавающей точки на границе
  while (xpForLevel(lvl + 1, base, exp) <= xp) lvl++;
  while (lvl > 0 && xpForLevel(lvl, base, exp) > xp) lvl--;
  return lvl;
}

export function titleForLevel(level: number): string {
  if (level >= 30) return 'Легенда Монолита';
  if (level >= 20) return 'Грандмастер';
  if (level >= 15) return 'Мастер';
  if (level >= 10) return 'Ветеран';
  if (level >= 5) return 'Боец';
  return 'Стажёр';
}

// ── типы результата тика ─────────────────────────────────────────────────────

export interface XpLedgerRow {
  dealId: number;
  bitrixId: number;
  soldDay: string | null;
  shipDay: string | null;
  saleXp: number;
  shipXp: number;
  mult: number;
  bonusXp: number;
  totalXp: number;
  classes: Record<string, number>;
}

/** Совместимо с AwardRow движка бейджей (compute.ts). */
export interface XpAwardRow {
  bitrixId: number;
  badgeKey: string;
  tier: null;
  periodType: 'day' | null;
  periodDate: string | null;
  value: number | null;
  counter?: boolean;
}

export interface XpTickResult {
  ledger: XpLedgerRow[];
  awards: XpAwardRow[];
  stats: { deals: number; managers: number; totalXp: number; boundedManagers: number };
}

// ── границы людей (слот-модель) ──────────────────────────────────────────────

async function fetchPersonStarts(): Promise<Map<number, string>> {
  const res = await analyticsDb().query<{
    bitrix_id: number; manual_start: string | null; hist_cnt: string; open_from: string | null;
  }>(
    `SELECT e.bitrix_id,
            to_char(r.manual_start_date, 'YYYY-MM-DD') AS manual_start,
            coalesce(h.cnt, 0)::text AS hist_cnt,
            to_char(h.open_from, 'YYYY-MM-DD') AS open_from
       FROM sa.employees e
       LEFT JOIN sa.employee_registry r ON r.bitrix_id = e.bitrix_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS cnt,
                max(valid_from) FILTER (WHERE valid_to IS NULL) AS open_from
           FROM sa.employee_name_history nh
          WHERE nh.bitrix_user_id = e.bitrix_id::text
       ) h ON true
      WHERE e.bitrix_id IS NOT NULL`,
  );
  const out = new Map<number, string>();
  for (const r of res.rows) {
    // manual_start_date — главный источник (Серёга правит руками на «Сотрудниках»);
    // фолбэк — valid_from текущего имени, только если были реальные переименования
    // (>1 строки истории). Иначе границы нет (дата первой сделки ничего не режет).
    const start = r.manual_start ?? (Number(r.hist_cnt) > 1 ? r.open_from : null);
    if (start) out.set(r.bitrix_id, start);
  }
  return out;
}

// ── основной пересчёт ────────────────────────────────────────────────────────

interface DealRow {
  deal_id: number; mgr: number; amount: string;
  sold_day: string | null; ship_day: string | null; created_day: string | null;
  is_repeat: boolean; head_group: string | null;
  grps: string[] | null;
  rn: string | null;                 // номер продажи клиента (вся история)
  prev_sold_day: string | null;      // предыдущая продажа клиента (для Некроманта)
  prev_grps: string[] | null;        // группы предыдущей продажи (для допродажи)
  work_days: string | null;          // рабочее время в WORK до продажи (deal_events)
}

const DEALS_SQL = `
WITH sold_seq AS (
  SELECT d.deal_id,
         row_number() OVER w AS rn,
         (LAG(d.sold_at) OVER w AT TIME ZONE '${MSK}')::date::text AS prev_sold_day,
         LAG(dg.grps) OVER w AS prev_grps
  FROM sa.deals d
  CROSS JOIN LATERAL (
    SELECT array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
                 WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                   AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps
  ) dg
  WHERE d.sold_at IS NOT NULL AND d.funnel_id IN (0,1,2,3)
    AND (CASE WHEN d.funnel_id IN (0,2) THEN d.contact_id ELSE d.company_id END) IS NOT NULL
  WINDOW w AS (
    PARTITION BY (CASE WHEN d.funnel_id IN (0,2) THEN 'c'||d.contact_id ELSE 'k'||d.company_id END)
    ORDER BY d.sold_at, d.deal_id
  )
),
work_stages AS (
  SELECT id FROM sa.stages WHERE stage_type = 'WORK' AND event_type NOT IN ('sold','shipped')
),
wt AS (
  -- Рабочее время сделки в WORK-стадиях до продажи (механика графика
  -- «В работе → продажа», stageSurvival.ts). Только сделки, созданные после
  -- старта сбора deal_events — иначе история неполная и скорость не меряется.
  SELECT ev.deal_id,
         SUM(EXTRACT(EPOCH FROM LEAST(coalesce(ev.next_at, ev.sold_at), ev.sold_at) - ev.event_at)) / 86400.0 AS days
  FROM (
    SELECT de.deal_id, de.stage_id, de.event_at, d.sold_at,
           LEAD(de.event_at) OVER (PARTITION BY de.deal_id ORDER BY de.event_at) AS next_at
    FROM sa.deal_events de
    JOIN sa.deals d ON d.deal_id = de.deal_id
    WHERE d.sold_at IS NOT NULL AND d.sold_at >= '${XP_RETRO_START}'
      AND d.created_at >= '${DEAL_EVENTS_START}'
  ) ev
  JOIN work_stages ws ON ws.id = ev.stage_id
  WHERE ev.event_at < ev.sold_at
  GROUP BY ev.deal_id
)
SELECT d.deal_id, d.current_manager_id AS mgr, coalesce(d.amount, 0)::text AS amount,
       (d.sold_at AT TIME ZONE '${MSK}')::date::text AS sold_day,
       (d.delivered_at AT TIME ZONE '${MSK}')::date::text AS ship_day,
       (d.created_at AT TIME ZONE '${MSK}')::date::text AS created_day,
       coalesce(f.is_repeat, false) AS is_repeat,
       d.head_group_name AS head_group,
       array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
             WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
               AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps,
       ss.rn::text AS rn, ss.prev_sold_day, ss.prev_grps,
       w.days::text AS work_days
FROM sa.deals d
LEFT JOIN sa.funnels f ON f.id = d.funnel_id
LEFT JOIN sold_seq ss ON ss.deal_id = d.deal_id
LEFT JOIN wt w ON w.deal_id = d.deal_id
WHERE d.current_manager_id IS NOT NULL
  AND (d.sold_at >= '${XP_RETRO_START}' OR d.delivered_at >= '${XP_RETRO_START}')
`;

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Полный пересчёт XP. `system` — соединение системной БД (настройки/маппинг
 * читаются из него, чтобы тик и кнопка видели актуальные правки).
 * Леджер НЕ пишет — это делает writeXpLedger в транзакции вызывающего.
 */
export async function computeXpTick(
  system: Pool | PoolClient,
  isBadgeEnabled: (key: string) => boolean,
): Promise<XpTickResult> {
  const [settings, classMap, starts, matrix, dealsRes] = await Promise.all([
    loadXpSettings(system),
    loadClassMap(system),
    fetchPersonStarts(),
    fetchCrossSellMatrix(),
    analyticsDb().query<DealRow>(DEALS_SQL),
  ]);

  // Медианы скорости по товарным группам (только валидная история deal_events):
  // группа с >= SPEED_MIN_SAMPLE наблюдений — своя медиана, иначе глобальная.
  const speedByGroup = new Map<string, number[]>();
  const speedAll: number[] = [];
  for (const d of dealsRes.rows) {
    if (d.work_days === null || d.sold_day === null) continue;
    const days = Number(d.work_days);
    const g = d.head_group ?? '—';
    (speedByGroup.get(g) ?? speedByGroup.set(g, []).get(g)!).push(days);
    speedAll.push(days);
  }
  const globalSpeedMedian = median(speedAll);
  const speedMedian = (g: string | null): number | null => {
    const arr = g !== null ? speedByGroup.get(g) : undefined;
    if (arr && arr.length >= SPEED_MIN_SAMPLE) return median(arr);
    return globalSpeedMedian;
  };

  const ledger: XpLedgerRow[] = [];
  let boundedManagers = 0;
  const boundedSeen = new Set<number>();

  for (const d of dealsRes.rows) {
    const mgr = d.mgr;
    const start = starts.get(mgr) ?? null;
    const floor = start !== null && start > XP_RETRO_START ? start : XP_RETRO_START;
    const amount = Number(d.amount);
    if (start !== null && start > XP_RETRO_START && !boundedSeen.has(mgr)) {
      boundedSeen.add(mgr); boundedManagers++;
    }

    const soldIn = d.sold_day !== null && d.sold_day >= floor;
    const shipIn = d.ship_day !== null && d.ship_day >= floor;
    if (!soldIn && !shipIn) continue;

    const saleXp = soldIn ? settings.saleFix + Math.min(Math.floor(amount / settings.salePerRub), settings.saleSumCap) : 0;
    const shipXp = shipIn ? settings.shipFix + Math.min(Math.floor(amount / settings.shipPerRub), settings.shipSumCap) : 0;

    // Множители: повторка / допродажа — НЕ стакуются (берётся больший);
    // скорость — бонус поверх. Применяются только когда есть продажная часть.
    let mult = 1;
    let crossSold = false;
    if (soldIn) {
      if (d.prev_grps && d.prev_grps.length > 0 && d.grps && d.grps.length > 0) {
        const rec = recommendFor(matrix, d.prev_grps);
        if (rec && !rec.fallback) {
          const recommended = new Set(rec.items.map(i => i.group));
          crossSold = d.grps.some(g => recommended.has(g));
        }
      }
      mult = Math.max(d.is_repeat ? settings.repeatMult : 1, crossSold ? settings.crosssellMult : 1);
      const med = d.work_days !== null ? speedMedian(d.head_group) : null;
      if (med !== null && d.work_days !== null && Number(d.work_days) < med) {
        mult = mult * (1 + settings.speedBonus);
      }
    }

    const bonus = soldIn && d.rn !== null && Number(d.rn) === 2 ? settings.regularBonus : 0;
    const total = Math.round((saleXp + shipXp) * mult + bonus);
    if (total <= 0) continue;

    // Классы: XP сделки делится поровну между уникальными классами её товарных
    // групп; без товарных групп — класс «Прочее».
    const classSet = new Set<string>();
    for (const g of d.grps ?? []) classSet.add(classMap.get(g) ?? OTHER_CLASS);
    if (classSet.size === 0) classSet.add(OTHER_CLASS);
    const classes: Record<string, number> = {};
    const list = [...classSet];
    const share = Math.floor(total / list.length);
    list.forEach((c, i) => { classes[c] = share + (i === 0 ? total - share * list.length : 0); });

    ledger.push({
      dealId: d.deal_id, bitrixId: mgr,
      soldDay: soldIn ? d.sold_day : null, shipDay: shipIn ? d.ship_day : null,
      saleXp, shipXp, mult: Math.round(mult * 100) / 100, bonusXp: bonus, totalXp: total, classes,
    });
  }

  // ── награды ────────────────────────────────────────────────────────────────
  const awards: XpAwardRow[] = [];
  const byMgr = new Map<number, XpLedgerRow[]>();
  for (const r of ledger) (byMgr.get(r.bitrixId) ?? byMgr.set(r.bitrixId, []).get(r.bitrixId)!).push(r);

  // Level Up (тихая, +price за каждый уровень): одна награда на (менеджер,
  // уровень) с СИНТЕТИЧЕСКОЙ стабильной датой 2000-01-01+уровень — идемпотентно
  // и не плодит дубли при смене коэффициентов (реальная дата достижения при
  // смене настроек «уезжала» бы и создавала повторные начисления). Дата нигде
  // не показывается: бейдж silent, выписка показывает дату начисления.
  const synthDate = (level: number): string => {
    const d = new Date(Date.parse('2000-01-01T12:00:00Z') + level * 86_400_000);
    return d.toISOString().slice(0, 10);
  };
  if (isBadgeEnabled('xp_level_up')) {
    for (const [mgr, rows] of byMgr) {
      const total = rows.reduce((s, r) => s + r.totalXp, 0);
      const level = levelFromXp(total, settings.levelBase, settings.levelExp);
      for (let n = 1; n <= level; n++) {
        awards.push({ bitrixId: mgr, badgeKey: 'xp_level_up', tier: null, periodType: 'day', periodDate: synthDate(n), value: n });
      }
    }
  }

  // Первая кровь: первая продажа в новой для менеджера товарной группе.
  // Считается по всей истории; НАГРАЖДАЕТСЯ только если дебют >= ретро-старта
  // наградной системы (03.04.2026). Награда per (менеджер, день); несколько
  // дебютов в один день сливаются в одну награду (value = сколько групп).
  if (isBadgeEnabled('xp_first_group')) {
    const firstByMgrGroup = new Map<string, string>(); // `${mgr}:${group}` -> день
    for (const d of dealsRes.rows) {
      if (d.sold_day === null) continue;
      for (const g of d.grps ?? []) {
        const k = `${d.mgr}:${g}`;
        const cur = firstByMgrGroup.get(k);
        if (!cur || d.sold_day < cur) firstByMgrGroup.set(k, d.sold_day);
      }
    }
    const perDay = new Map<string, number>(); // `${mgr}:${day}` -> новых групп
    for (const [k, day] of firstByMgrGroup) {
      if (day < AWARD_RETRO_START) continue;
      const mgr = k.slice(0, k.indexOf(':'));
      const dk = `${mgr}:${day}`;
      perDay.set(dk, (perDay.get(dk) ?? 0) + 1);
    }
    for (const [dk, n] of perDay) {
      const [mgr, day] = [Number(dk.slice(0, dk.indexOf(':'))), dk.slice(dk.indexOf(':') + 1)];
      awards.push({ bitrixId: mgr, badgeKey: 'xp_first_group', tier: null, periodType: 'day', periodDate: day, value: n });
    }
  }

  // Мастер класса / Полимат — по уровням классов.
  const classTotals = new Map<number, Map<string, number>>();
  for (const r of ledger) {
    const m = classTotals.get(r.bitrixId) ?? classTotals.set(r.bitrixId, new Map()).get(r.bitrixId)!;
    for (const [c, xp] of Object.entries(r.classes)) m.set(c, (m.get(c) ?? 0) + xp);
  }
  for (const [mgr, m] of classTotals) {
    let masters = 0; let fivePlus = 0;
    for (const xp of m.values()) {
      const lvl = levelFromXp(xp, settings.classLevelBase, settings.levelExp);
      if (lvl >= 10) masters++;
      if (lvl >= 5) fivePlus++;
    }
    if (masters > 0 && isBadgeEnabled('xp_class_master')) {
      awards.push({ bitrixId: mgr, badgeKey: 'xp_class_master', tier: null, periodType: null, periodDate: null, value: masters, counter: true });
    }
    if (fivePlus >= 3 && isBadgeEnabled('xp_polymath')) {
      awards.push({ bitrixId: mgr, badgeKey: 'xp_polymath', tier: null, periodType: null, periodDate: null, value: fivePlus, counter: true });
    }
  }

  // НЕКРОМАНТ: продажа клиенту после >= 365 дней молчания (награды — с ретро-старта наград).
  if (isBadgeEnabled('xp_necromancer')) {
    const necro = new Map<number, number>();
    for (const d of dealsRes.rows) {
      if (d.sold_day === null || d.sold_day < AWARD_RETRO_START || d.prev_sold_day === null) continue;
      const gap = (Date.parse(d.sold_day) - Date.parse(d.prev_sold_day)) / 86_400_000;
      if (gap >= 365) necro.set(d.mgr, (necro.get(d.mgr) ?? 0) + 1);
    }
    for (const [mgr, n] of necro) {
      awards.push({ bitrixId: mgr, badgeKey: 'xp_necromancer', tier: null, periodType: null, periodDate: null, value: n, counter: true });
    }
  }

  return {
    ledger, awards,
    stats: {
      deals: ledger.length,
      managers: byMgr.size,
      totalXp: ledger.reduce((s, r) => s + r.totalXp, 0),
      boundedManagers,
    },
  };
}

/** Полная идемпотентная перезапись леджера (в транзакции вызывающего). */
export async function writeXpLedger(client: PoolClient, rows: XpLedgerRow[]): Promise<void> {
  await client.query(`DELETE FROM xp_ledger`);
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await client.query(
      `INSERT INTO xp_ledger (deal_id, bitrix_id, sold_day, ship_day, sale_xp, ship_xp, mult, bonus_xp, total_xp, classes)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::date[], $4::date[], $5::int[], $6::int[], $7::numeric[], $8::int[], $9::int[], $10::jsonb[])`,
      [
        chunk.map(r => r.dealId), chunk.map(r => r.bitrixId),
        chunk.map(r => r.soldDay), chunk.map(r => r.shipDay),
        chunk.map(r => r.saleXp), chunk.map(r => r.shipXp),
        chunk.map(r => r.mult), chunk.map(r => r.bonusXp), chunk.map(r => r.totalXp),
        chunk.map(r => JSON.stringify(r.classes)),
      ],
    );
  }
}

// ── чтение для UI ────────────────────────────────────────────────────────────

export interface XpProfile {
  totalXp: number;
  level: number;
  title: string;
  nextLevelXp: number;      // сколько XP нужно для следующего уровня (порог)
  currentLevelXp: number;   // порог текущего уровня
  classes: { name: string; xp: number; level: number; progress: number }[];  // по убыванию XP; progress 0..100 до следующего уровня
  topClass: { name: string; level: number } | null;
}

export async function fetchXpProfile(system: Pool, bitrixId: number): Promise<XpProfile> {
  const [settings, totals, cls] = await Promise.all([
    loadXpSettings(system),
    system.query<{ total: string | null }>(`SELECT sum(total_xp)::text AS total FROM xp_ledger WHERE bitrix_id = $1`, [bitrixId]),
    system.query<{ name: string; xp: string }>(
      `SELECT c.key AS name, sum(c.value::numeric)::text AS xp
         FROM xp_ledger l, jsonb_each_text(l.classes) c
        WHERE l.bitrix_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
      [bitrixId],
    ),
  ]);
  const totalXp = Math.round(Number(totals.rows[0]?.total ?? 0));
  const level = levelFromXp(totalXp, settings.levelBase, settings.levelExp);
  const classes = cls.rows.map(r => {
    const xp = Math.round(Number(r.xp));
    const lvl = levelFromXp(xp, settings.classLevelBase, settings.levelExp);
    const cur = lvl > 0 ? xpForLevel(lvl, settings.classLevelBase, settings.levelExp) : 0;
    const next = xpForLevel(lvl + 1, settings.classLevelBase, settings.levelExp);
    const progress = next > cur ? Math.min(100, Math.round(((xp - cur) / (next - cur)) * 100)) : 100;
    return { name: r.name, xp, level: lvl, progress };
  }).sort((a, b) => b.xp - a.xp);
  const top = classes.filter(c => c.level > 0)[0] ?? null;
  return {
    totalXp, level, title: titleForLevel(level),
    nextLevelXp: xpForLevel(level + 1, settings.levelBase, settings.levelExp),
    currentLevelXp: level > 0 ? xpForLevel(level, settings.levelBase, settings.levelExp) : 0,
    classes,
    topClass: top ? { name: top.name, level: top.level } : null,
  };
}

export interface XpBrief { level: number; title: string; totalXp: number; topClass: { name: string; level: number } | null }

/** Батч для рейтинга/команды: уровни и топ-классы пачки менеджеров. */
export async function fetchXpBriefs(system: Pool, bitrixIds: number[]): Promise<Map<number, XpBrief>> {
  const out = new Map<number, XpBrief>();
  if (bitrixIds.length === 0) return out;
  const [settings, totals, cls] = await Promise.all([
    loadXpSettings(system),
    system.query<{ bitrix_id: number; total: string }>(
      `SELECT bitrix_id, sum(total_xp)::text AS total FROM xp_ledger WHERE bitrix_id = ANY($1::bigint[]) GROUP BY 1`,
      [bitrixIds],
    ),
    system.query<{ bitrix_id: number; name: string; xp: string }>(
      `SELECT l.bitrix_id, c.key AS name, sum(c.value::numeric)::text AS xp
         FROM xp_ledger l, jsonb_each_text(l.classes) c
        WHERE l.bitrix_id = ANY($1::bigint[]) GROUP BY 1, 2`,
      [bitrixIds],
    ),
  ]);
  const bestClass = new Map<number, { name: string; xp: number }>();
  for (const r of cls.rows) {
    const xp = Number(r.xp);
    const cur = bestClass.get(r.bitrix_id);
    if (!cur || xp > cur.xp) bestClass.set(r.bitrix_id, { name: r.name, xp });
  }
  for (const r of totals.rows) {
    const totalXp = Math.round(Number(r.total));
    const level = levelFromXp(totalXp, settings.levelBase, settings.levelExp);
    const bc = bestClass.get(r.bitrix_id);
    const bcLevel = bc ? levelFromXp(bc.xp, settings.classLevelBase, settings.levelExp) : 0;
    out.set(r.bitrix_id, {
      level, title: titleForLevel(level), totalXp,
      topClass: bc && bcLevel > 0 ? { name: bc.name, level: bcLevel } : null,
    });
  }
  return out;
}
