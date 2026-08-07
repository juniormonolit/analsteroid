// Движок дерева скиллов (задача 49, миграции 159/165/166).
//
// ЗАМЫСЕЛ (PROGRESSION_IDEAS §5-бис и §5-тер, решения владельца 06.08.2026):
// у каждой из десяти веток свой уровень. Уровень качается работой И оплачивается
// MLT — купить то, чего не наработал, нельзя. На порогах 2/5/9/14/20
// открывается СЛЕДУЮЩАЯ ступень награды этой ветки: та же награда, но с более
// высоким порогом и большей ценой. Пройдя порог, человек перестаёт получать
// младшую ступень и начинает получать старшую — это и есть ротация.
//
// ЖЕЛЕЗНОЕ ПРАВИЛО: прокачка не должна снижать доход. Оно держится не на коде,
// а на калибровке — цена ступени растёт ×1,8, а частота по замеру 07.08 падает
// вчетверо (миграция 165). Код обязан лишь не ломать это: ротация ВСЕГДА
// заменяет награду на ровно одну ступень, никогда не выдаёт две сразу.
//
// ЧТО ЗДЕСЬ. Чтение уровней, разрешение «уровень → ступень → персональный
// порог», ротация тира у уже посчитанных наград, множители и покупка уровня.
// Сами награды считает `compute.ts`; он спрашивает отсюда пороги ДО расчёта
// (у счётчиков порог фильтрует входные данные, поверх готовой награды его не
// наложить) и применяет ротацию ПОСЛЕ (у периодических хватает значения).

import type { Pool, PoolClient } from 'pg';
import { spendPinRequirement, verifyPin, type PinActorCtx } from '@/lib/auth/pin';

export const UNLOCK_LEVELS = [2, 5, 9, 14, 20] as const;
export const MAX_LEVEL = 20;

/** Цена n-го уровня ветки — 5·n^1,5 (PROGRESSION_IDEAS §5-бис). */
export function levelPrice(level: number): number {
  return Math.max(1, Math.round(5 * Math.pow(level, 1.5)));
}

/** Сколько наград ветки нужно иметь, чтобы КУПИТЬ n-й уровень.
 *  Одна награда на уровень: «заработал» — это буквально «получил награду этой
 *  ветки», а не абстрактный счётчик. Заодно делает прогресс видимым: человек
 *  понимает, что качает, потому что качает тем же, чем зарабатывает. */
export function progressNeeded(level: number): number {
  return level;
}

export interface SkillStep {
  branchKey: string; step: number; unlockLevel: number;
  badgeKey: string; tier: string; threshold: Record<string, number>; price: number;
}

export interface SkillBranch {
  key: string; name: string; emoji: string; description: string | null; sort: number;
}

export async function loadSkillBranches(db: Pool | PoolClient): Promise<SkillBranch[]> {
  try {
    const r = await db.query<SkillBranch & { sort: number }>(
      `SELECT key, name, emoji, description, sort FROM skill_branches ORDER BY sort, key`,
    );
    return r.rows;
  } catch { return []; }
}

export async function loadSkillSteps(db: Pool | PoolClient): Promise<SkillStep[]> {
  try {
    const r = await db.query<{ branch_key: string; step: number; unlock_level: number;
      badge_key: string; tier: string; threshold: Record<string, number>; price: number }>(
      `SELECT branch_key, step, unlock_level, badge_key, tier, threshold, price
         FROM skill_branch_steps ORDER BY branch_key, step`,
    );
    return r.rows.map(x => ({
      branchKey: x.branch_key, step: x.step, unlockLevel: x.unlock_level,
      badgeKey: x.badge_key, tier: x.tier, threshold: x.threshold ?? {}, price: x.price,
    }));
  } catch { return []; }  // до миграции 159 таблицы нет — движок молча не работает
}

/** Уровни всех менеджеров: bitrix_id → branch_key → level. */
export async function loadSkillLevels(db: Pool | PoolClient): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>();
  try {
    const r = await db.query<{ bitrix_id: string; branch_key: string; level: number }>(
      `SELECT bitrix_id::text, branch_key, level FROM skill_levels WHERE level > 0`,
    );
    for (const x of r.rows) {
      const mgr = Number(x.bitrix_id);
      (out.get(mgr) ?? out.set(mgr, new Map()).get(mgr)!).set(x.branch_key, Number(x.level));
    }
  } catch { /* до миграции 166 таблицы нет — у всех уровень 0 */ }
  return out;
}

/** Контекст веток на один прогон пересчёта наград. */
export class SkillContext {
  readonly steps: SkillStep[];
  readonly levels: Map<number, Map<string, number>>;
  private byBadge = new Map<string, SkillStep[]>();   // badge_key → ступени по возрастанию

  // Поля присваиваются явно, без parameter properties: assert-скрипты проекта
  // запускаются Node-ом в режиме strip-only, а он такой синтаксис не понимает.
  constructor(steps: SkillStep[], levels: Map<number, Map<string, number>>) {
    this.steps = steps;
    this.levels = levels;
    for (const s of steps) {
      (this.byBadge.get(s.badgeKey) ?? this.byBadge.set(s.badgeKey, []).get(s.badgeKey)!).push(s);
    }
    for (const list of this.byBadge.values()) list.sort((a, b) => a.step - b.step);
  }

  /** Награда принадлежит какой-то ветке? */
  isBranchBadge(badgeKey: string): boolean { return this.byBadge.has(badgeKey); }

  level(mgr: number, branchKey: string): number {
    return this.levels.get(mgr)?.get(branchKey) ?? 0;
  }

  /** Ступень, на которой сейчас стоит менеджер по этой награде.
   *  null — ни одна не открыта (уровень < 2), награда работает как раньше. */
  stepFor(mgr: number, badgeKey: string): SkillStep | null {
    const list = this.byBadge.get(badgeKey);
    if (!list || list.length === 0) return null;
    const lvl = this.level(mgr, list[0].branchKey);
    let best: SkillStep | null = null;
    for (const s of list) if (lvl >= s.unlockLevel) best = s;   // список отсортирован
    return best;
  }

  /** Персональный порог награды: значение поля `field` из открытой ступени,
   *  иначе общий дефолт из criteria. Нужен ДО расчёта — у счётчиков
   *  (`loyal_client`, `combo_master`) порог решает, какие клиенты/пары вообще
   *  попадут в счёт, и поверх готовой награды его наложить нельзя. */
  thresholdFor(mgr: number, badgeKey: string, field: string, dflt: number): number {
    const s = this.stepFor(mgr, badgeKey);
    const v = s?.threshold?.[field];
    return v === undefined || v === null ? dflt : Number(v);
  }

  /** Тир, с которым награда должна лечь в `badge_awards` (иначе null = как раньше). */
  tierFor(mgr: number, badgeKey: string): string | null {
    return this.stepFor(mgr, badgeKey)?.tier ?? null;
  }

  /** Множители за пройденные пороги (решение владельца: символические).
   *  +5 % XP и +1 % MLT за каждый порог ветки, то есть до +25 % / +5 % на
   *  полностью прокачанной. Считаются по ВСЕМ веткам сразу: смысл множителя —
   *  «видно, что растёт», а не отдельная экономика на каждую ось. */
  multipliers(mgr: number): { xp: number; mlt: number; thresholds: number } {
    const mine = this.levels.get(mgr);
    if (!mine) return { xp: 1, mlt: 1, thresholds: 0 };
    let n = 0;
    for (const lvl of mine.values()) n += UNLOCK_LEVELS.filter(u => lvl >= u).length;
    return { xp: 1 + 0.05 * n, mlt: 1 + 0.01 * n, thresholds: n };
  }
}

export async function loadSkillContext(db: Pool | PoolClient): Promise<SkillContext> {
  const [steps, levels] = await Promise.all([loadSkillSteps(db), loadSkillLevels(db)]);
  return new SkillContext(steps, levels);
}

/** Ротация тира у периодических наград.
 *
 *  Для наград, где значение награды И ЕСТЬ измеряемая величина (сумма отгрузок,
 *  конверсия, число первичных продаж), ступень можно применить уже к готовому
 *  результату: если значение не дотягивает до порога открытой ступени — награды
 *  НЕТ вовсе (в этом и смысл ротации: ветеран больше не получает лёгкую), если
 *  дотягивает — тир заменяется на ступенчатый.
 *
 *  Счётчики (`loyal_client`, `combo_master`) сюда не попадают: у них порог
 *  меняет сам расчёт, и `compute.ts` спрашивает `thresholdFor` заранее.
 *  Им нужен только тир — для этого `tierOnly`. */
export function rotateAward<T extends { bitrixId: number; badgeKey: string; tier: string | null; value: number | null }>(
  ctx: SkillContext, award: T, field: string, opts: { tierOnly?: boolean } = {},
): T | null {
  const step = ctx.stepFor(award.bitrixId, award.badgeKey);
  if (!step) return award;                       // ни одна ступень не открыта
  if (!opts.tierOnly) {
    const need = Number(step.threshold?.[field] ?? 0);
    if (need > 0 && (award.value ?? 0) < need) return null;
  }
  return { ...award, tier: step.tier };
}

// ── четыре новые оси: их наград в каталоге не было вовсе ─────────────────────

/** Ось ветки, у которой награда считается метрикой каталога.
 *  Метрика — та же, что в отчётах и квестах: «награда за конверсию» и
 *  «конверсия в моём отчёте» обязаны быть одним числом. Сумма отгрузок —
 *  единственная составная: отдельной метрики в каталоге нет, складываем
 *  первичные и повторные. */
export const BRANCH_AXES: Record<string, {
  badgeKey: string; metrics: string[]; unit: 'week' | 'month'; field: string;
}> = {
  primary:   { badgeKey: 'primary_week',       metrics: ['primary_sales_count'], unit: 'week', field: 'minCount' },
  shipments: { badgeKey: 'shipments_month',    metrics: ['primary_shipments_amount', 'repeat_shipments_amount'], unit: 'month', field: 'minAmount' },
  ppp:       { badgeKey: 'ppp_month',          metrics: ['ppp_count'], unit: 'month', field: 'minPpp' },
  booking:   { badgeKey: 'booking_conv_month', metrics: ['cr_deal_to_reservation_all'], unit: 'month', field: 'minConv' },
};

export interface AxisAward {
  bitrixId: number; badgeKey: string; tier: string | null;
  periodType: 'week' | 'month'; periodDate: string; value: number;
}

/** Награды четырёх новых осей за все закрытые периоды с ретро-старта.
 *
 *  Ступень применяется ЗДЕСЬ, а не общей ротацией: у этих осей значение
 *  награды и есть измеряемая величина, и «не дотянул до своей ступени» должно
 *  означать «награды нет», а не «награда с прежним порогом». Уровень 0 —
 *  работает базовый порог первой ступени: иначе ось выдавала бы награду вообще
 *  без условия (в `badge_definitions` у этих четырёх criteria пустой, там
 *  только `{"branch": ...}`).
 *
 *  Периоды берём ЗАКРЫТЫЕ: незакрытая неделя дала бы награду за полнедели. */
export async function computeAxisAwards(
  ctx: SkillContext, retroStart: string, today: string,
): Promise<AxisAward[]> {
  const { sampleMetricByManagerPeriod } = await import('@/features/quests/engine/metricQuests');
  const out: AxisAward[] = [];
  for (const [branch, axis] of Object.entries(BRANCH_AXES)) {
    const steps = ctx.steps.filter(s => s.branchKey === branch).sort((a, b) => a.step - b.step);
    if (steps.length === 0) continue;
    const byKey = new Map<string, number>();   // `${mgr}|${bucket}` → сумма метрик
    for (const metricId of axis.metrics) {
      let samples: Awaited<ReturnType<typeof sampleMetricByManagerPeriod>>;
      try {
        samples = await sampleMetricByManagerPeriod(metricId, axis.unit, retroStart, today);
      } catch (e) {
        console.warn(`[skills] ось ${branch}: метрика ${metricId} не посчиталась:`, e instanceof Error ? e.message : e);
        continue;
      }
      for (const s of samples) {
        const k = `${s.mgr}|${s.bucket}`;
        byKey.set(k, (byKey.get(k) ?? 0) + s.value);
      }
    }
    for (const [k, value] of byKey) {
      const sep = k.indexOf('|');
      const mgr = Number(k.slice(0, sep));
      const bucket = k.slice(sep + 1);
      if (!periodClosed(axis.unit, bucket, today)) continue;
      // Ступень человека; уровень 0 → базовая (первая).
      const step = ctx.stepFor(mgr, axis.badgeKey) ?? steps[0];
      const need = Number(step.threshold?.[axis.field] ?? 0);
      if (need > 0 && value < need) continue;
      out.push({
        bitrixId: mgr, badgeKey: axis.badgeKey,
        tier: ctx.level(mgr, branch) > 0 ? step.tier : steps[0].tier,
        periodType: axis.unit, periodDate: bucket, value: Math.round(value * 100) / 100,
      });
    }
  }
  return out;
}

/** Период закрылся? Незакрытый награждать нельзя — награда за полпериода. */
function periodClosed(unit: 'week' | 'month', bucketStart: string, today: string): boolean {
  const d = new Date(`${bucketStart}T12:00:00Z`);
  if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10) <= today;
}

// ── покупка уровня ───────────────────────────────────────────────────────────

export interface BranchState {
  branchKey: string; name: string; emoji: string; description: string | null;
  level: number; progress: number;               // сколько наград ветки получено
  nextLevel: number | null; nextPrice: number | null; nextProgressNeeded: number | null;
  canBuy: boolean; blockedBy: 'max' | 'progress' | 'balance' | null;
  steps: { step: number; unlockLevel: number; threshold: Record<string, number>; price: number; unlocked: boolean }[];
}

/** Прогресс всех веток менеджера: сколько наград каждой ветки он получил.
 *  Считаем по `badge_awards` — по факту выдачи, а не по «сколько мог бы». */
async function fetchBranchProgress(db: Pool | PoolClient, mgr: number): Promise<Map<string, number>> {
  const r = await db.query<{ branch_key: string; n: string }>(
    `SELECT s.branch_key, count(DISTINCT a.id)::text AS n
       FROM badge_awards a
       JOIN (SELECT DISTINCT branch_key, badge_key FROM skill_branch_steps) s
         ON s.badge_key = a.badge_key
      WHERE a.bitrix_id = $1
      GROUP BY 1`,
    [mgr],
  );
  return new Map(r.rows.map(x => [x.branch_key, Number(x.n)]));
}

export async function fetchSkillTree(db: Pool, mgr: number): Promise<{ branches: BranchState[]; balance: number; multipliers: { xp: number; mlt: number; thresholds: number } }> {
  const [branches, steps, levelsRows, progress, bal] = await Promise.all([
    loadSkillBranches(db),
    loadSkillSteps(db),
    db.query<{ branch_key: string; level: number }>(
      `SELECT branch_key, level FROM skill_levels WHERE bitrix_id = $1`, [mgr]),
    fetchBranchProgress(db, mgr),
    db.query<{ b: string }>(`SELECT coalesce(balance,0)::text AS b FROM badge_coin_balances WHERE bitrix_id=$1`, [mgr]),
  ]);
  const levelOf = new Map(levelsRows.rows.map(r => [r.branch_key, Number(r.level)]));
  const balance = Number(bal.rows[0]?.b ?? 0);

  const out: BranchState[] = branches.map(b => {
    const level = levelOf.get(b.key) ?? 0;
    const prog = progress.get(b.key) ?? 0;
    const next = level >= MAX_LEVEL ? null : level + 1;
    const price = next === null ? null : levelPrice(next);
    const need = next === null ? null : progressNeeded(next);
    let blockedBy: BranchState['blockedBy'] = null;
    if (next === null) blockedBy = 'max';
    else if (prog < need!) blockedBy = 'progress';
    else if (balance < price!) blockedBy = 'balance';
    return {
      branchKey: b.key, name: b.name, emoji: b.emoji, description: b.description,
      level, progress: prog, nextLevel: next, nextPrice: price, nextProgressNeeded: need,
      canBuy: blockedBy === null, blockedBy,
      steps: steps.filter(s => s.branchKey === b.key).map(s => ({
        step: s.step, unlockLevel: s.unlockLevel, threshold: s.threshold,
        price: s.price, unlocked: level >= s.unlockLevel,
      })),
    };
  });

  const levels = new Map([[mgr, levelOf]]);
  const mult = new SkillContext(steps, levels).multipliers(mgr);
  return { branches: out, balance, multipliers: mult };
}

export type BuyResult =
  | { ok: true; branchKey: string; level: number; price: number }
  | { ok: false; error: string; status?: number };

/** Купить следующий уровень ветки: списывает MLT и поднимает уровень на 1.
 *  Всё в одной транзакции; повторная покупка того же уровня отбивается
 *  уникальным индексом `skill_level_ups (bitrix_id, branch_key, level)` —
 *  двойной клик не спишет дважды. */
export async function buySkillLevel(
  db: Pool, mgr: number, branchKey: string, actorLogin: string,
  pinActor: PinActorCtx, pin: unknown,
): Promise<BuyResult> {
  const branch = (await loadSkillBranches(db)).find(b => b.key === branchKey);
  if (!branch) return { ok: false, error: 'Ветка не найдена' };

  // Личный порог пина (задача #2995) — как у любой траты MLT. Считается ДО
  // денежной транзакции: verifyPin коммитит счётчик неудач в СВОЕЙ транзакции,
  // внутри чужой это разъехалось бы при откате.
  const levelNow = Number((await db.query<{ level: number }>(
    `SELECT level FROM skill_levels WHERE bitrix_id=$1 AND branch_key=$2`, [mgr, branchKey],
  )).rows[0]?.level ?? 0);
  if (levelNow >= MAX_LEVEL) return { ok: false, error: 'Ветка уже прокачана до конца' };
  const need = await spendPinRequirement(db, mgr, levelPrice(levelNow + 1));
  let pinEventId: number | null = null;
  if (need.required) {
    const verified = await verifyPin(db, pinActor, pin, {
      operation: 'skill_level_up', targetRef: branchKey,
      amount: levelPrice(levelNow + 1), currency: 'EBALL',
    });
    if (!verified.ok) return { ok: false, error: verified.error, status: verified.status };
    pinEventId = verified.pinEventId;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Блокируем строку уровня: два параллельных клика не купят два уровня по
    // цене одного (цена зависит от текущего уровня).
    await client.query(
      `INSERT INTO skill_levels (bitrix_id, branch_key, level) VALUES ($1,$2,0)
       ON CONFLICT (bitrix_id, branch_key) DO NOTHING`,
      [mgr, branchKey],
    );
    const cur = await client.query<{ level: number }>(
      `SELECT level FROM skill_levels WHERE bitrix_id=$1 AND branch_key=$2 FOR UPDATE`,
      [mgr, branchKey],
    );
    const level = Number(cur.rows[0]?.level ?? 0);
    if (level >= MAX_LEVEL) { await client.query('ROLLBACK'); return { ok: false, error: 'Ветка уже прокачана до конца' }; }
    const next = level + 1;
    const price = levelPrice(next);
    const need = progressNeeded(next);

    const prog = (await fetchBranchProgress(client, mgr)).get(branchKey) ?? 0;
    if (prog < need) {
      await client.query('ROLLBACK');
      return { ok: false, error: `Нужно ${need} наград ветки, есть ${prog}. Уровень нельзя купить, не наработав его.` };
    }
    const bal = await client.query<{ b: string }>(
      `SELECT coalesce(balance,0)::text AS b FROM badge_coin_balances WHERE bitrix_id=$1`, [mgr]);
    if (Number(bal.rows[0]?.b ?? 0) < price) {
      await client.query('ROLLBACK');
      return { ok: false, error: `Не хватает MLT: нужно ${price}` };
    }

    const led = await client.query<{ id: string }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, actor_login, comment, pin_event_id)
       VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'skill_level_up', $3, $4, $5) RETURNING id`,
      [mgr, -price, actorLogin, `Ветка «${branch.name}»: уровень ${next}`, pinEventId],
    );
    await client.query(
      `INSERT INTO skill_level_ups (bitrix_id, branch_key, level, price, progress_at_up, coin_ledger_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [mgr, branchKey, next, price, prog, Number(led.rows[0].id)],
    );
    await client.query(
      `UPDATE skill_levels SET level=$3, updated_at=now() WHERE bitrix_id=$1 AND branch_key=$2`,
      [mgr, branchKey, next],
    );
    await client.query('COMMIT');
    return { ok: true, branchKey, level: next, price };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Уникальный индекс на (bitrix_id, branch_key, level) — гонка двух кликов.
    if (e instanceof Error && /skill_level_ups/.test(e.message)) {
      return { ok: false, error: 'Этот уровень уже куплен' };
    }
    throw e;
  } finally {
    client.release();
  }
}
