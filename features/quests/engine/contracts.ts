// Доска контрактов + лутдроп (дополнения Серёги 01.08, миграция 126).
// Контракты — общий пул: цели/сроки РАНДОМИЗИРОВАНЫ вокруг тир-порогов (чтобы
// выполнимость не просчитывалась на коленке), брать может любой любой тир,
// депозит = deposit_pct × награды (вернулся при успехе, сгорел при провале),
// лимит активных + кулдаун после провала, пул обновляется еженедельно и
// пополняется при взятии. Лутдроп — предмет магазина в инвентарь с шансом по
// тиру (ролл серверный, как у гачи; легендарный — гарантированный).

import type { Pool, PoolClient } from 'pg';
import { analyticsDb } from '@/lib/db/clients';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';
import { fetchCrossSellMatrix } from '@/features/customers/engine/crossSell';
import {
  fetchCompanyMedians, loadQuestSettings, mskToday, rollLoot,
  type LootDrop, type QuestCategory, type QuestTier,
} from './quests';

const MSK = 'Europe/Moscow';

// Диапазоны отношения цели к медиане компании по тирам (внутри тир-полос
// объективной шкалы: <=0.5 / 0.5-0.8 / 0.8-1.1 / 1.1-1.5 / >1.5).
const TIER_BANDS: Record<QuestTier, [number, number]> = {
  white: [0.3, 0.5], green: [0.55, 0.8], blue: [0.85, 1.1], epic: [1.15, 1.5], legendary: [1.6, 2.2],
};

export interface ContractRow {
  id: number; weekStart: string; category: QuestCategory; target: number;
  targetGroup: string | null; pairFirst: string | null; title: string; days: number;
  tier: QuestTier; rewardEballs: number; rewardXp: number; deposit: number;
  status: 'open' | 'taken' | 'done' | 'failed' | 'expired';
  takenBy: number | null; takenAt: string | null; deadline: string | null;
  progress: number; doneAt: string | null;
}

function ymd(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function rowFromDb(r: Record<string, unknown>): ContractRow {
  return {
    id: Number(r.id), weekStart: ymd(r.week_start)!, category: r.category as QuestCategory,
    target: Number(r.target), targetGroup: (r.target_group as string) ?? null,
    pairFirst: (r.pair_first as string) ?? null, title: String(r.title), days: Number(r.days),
    tier: r.tier as QuestTier, rewardEballs: Number(r.reward_eballs), rewardXp: Number(r.reward_xp),
    deposit: Number(r.deposit), status: r.status as ContractRow['status'],
    takenBy: r.taken_by != null ? Number(r.taken_by) : null,
    takenAt: r.taken_at ? new Date(r.taken_at as string).toISOString() : null,
    deadline: ymd(r.deadline), progress: Number(r.progress),
    doneAt: r.done_at ? new Date(r.done_at as string).toISOString() : null,
  };
}

function weekStartOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 1 - dow);
  return d.toISOString().slice(0, 10);
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pickOne = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const fmtMoney = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1).replace('.0', '')} млн ₽` : `${Math.round(v / 1000)} тыс ₽`;

/** Догенерировать открытые контракты недели до размера пула. */
export async function ensureContractPool(system: Pool | PoolClient): Promise<void> {
  const today = mskToday();
  const ws = weekStartOf(today);
  const settings = await loadQuestSettings(system);
  const extra = await system.query<Record<string, string>>(`SELECT contract_pool_size, deposit_pct FROM quest_settings WHERE id=1`);
  const poolSize = Number(extra.rows[0]?.contract_pool_size ?? 8);
  const depositPct = Number(extra.rows[0]?.deposit_pct ?? 0.3);
  const cur = await system.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM quest_contracts WHERE week_start = $1 AND status = 'open'`, [ws],
  );
  let need = poolSize - Number(cur.rows[0].c);
  if (need <= 0) return;

  const cm = await fetchCompanyMedians();
  const matrix = await fetchCrossSellMatrix();
  const groups = await analyticsDb().query<{ g: string }>(`
    SELECT p->>'head_group_name' AS g
    FROM sa.deals d, jsonb_array_elements(d.products) p
    WHERE d.sold_at >= now() - interval '90 days'
      AND coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
      AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)'
    GROUP BY 1 HAVING count(*) >= 100 ORDER BY count(*) DESC LIMIT 12
  `);
  const topGroups = groups.rows.map(r => r.g);
  const magistrals: { first: string; next: string }[] = [];
  for (const [from, f] of Object.entries(matrix.from)) {
    const best = Object.entries(f.to).sort((a, b) => b[1] - a[1])[0];
    if (best && f.total >= 300) magistrals.push({ first: from, next: best[0] });
  }
  const tiers: QuestTier[] = ['white', 'green', 'blue', 'blue', 'epic', 'epic', 'legendary', 'green'];

  while (need-- > 0) {
    const tier = tiers[Math.floor(Math.random() * tiers.length)];
    const [lo, hi] = TIER_BANDS[tier];
    const days = 3 + Math.floor(Math.random() * 5); // 3–7 дней
    const scale = days / 7;
    const kind = pickOne<QuestCategory>(['sales_count', 'sales_amount', 'group_sales', 'crosssell']);
    let target = 0; let targetGroup: string | null = null; let pairFirst: string | null = null; let title = '';
    const base = cm.week?.[kind] ?? 1;
    if (kind === 'sales_amount') {
      target = Math.max(Math.round((base * rand(lo, hi) * scale) / 50000) * 50000, 100000);
      title = `Контракт: продай на ${fmtMoney(target)} за ${days} дн.`;
    } else if (kind === 'sales_count') {
      target = Math.max(Math.round(base * rand(lo, hi) * scale), 1);
      title = `Контракт: ${target} ${target === 1 ? 'сделка' : target < 5 ? 'сделки' : 'сделок'} за ${days} дн.`;
    } else if (kind === 'group_sales') {
      targetGroup = pickOne(topGroups);
      target = Math.max(Math.round(base * rand(lo, hi) * scale * 2), 1);
      title = `Контракт: продай «${targetGroup}» ${target} раз${target > 1 && target < 5 ? 'а' : ''} за ${days} дн.`;
    } else {
      const m = pickOne(magistrals);
      targetGroup = m.next; pairFirst = m.first;
      target = Math.max(Math.round(base * rand(lo, hi) * scale), 1);
      title = `Контракт: допродай «${m.next}» после «${m.first}» (${target} шт.) за ${days} дн.`;
    }
    // Пересчёт фактического тира от получившейся цели (рандом мог сползти к краю полосы)
    const baseReward = settings.rewardWeek;
    const reward = Math.max(1, Math.round(baseReward * settings.tierMult[tier] * (0.9 + Math.random() * 0.2)));
    const rewardXp = Math.round(reward * settings.xpMult);
    const deposit = Math.max(1, Math.round(reward * depositPct));
    await system.query(
      `INSERT INTO quest_contracts (week_start, category, target, target_group, pair_first, title, days,
         tier, reward_eballs, reward_xp, deposit, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ws, kind, target, targetGroup, pairFirst, title, days, tier, reward, rewardXp, deposit,
        JSON.stringify({ band: TIER_BANDS[tier], companyBase: base, scale })],
    );
  }
  // Старые открытые контракты прошлых недель — протухают.
  await system.query(`UPDATE quest_contracts SET status='expired' WHERE status='open' AND week_start < $1`, [ws]);
}

/** Взять контракт: лимит активных, кулдаун после провала, депозит из кошелька. */
export async function takeContract(system: Pool, mgr: number, contractId: number, actorLogin: string):
  Promise<{ ok: true; contract: ContractRow } | { ok: false; error: string }> {
  const extra = await system.query<Record<string, string>>(
    `SELECT contract_limit, contract_cooldown_h FROM quest_settings WHERE id=1`,
  );
  const limit = Number(extra.rows[0]?.contract_limit ?? 2);
  const cooldownH = Number(extra.rows[0]?.contract_cooldown_h ?? 24);

  const activeCnt = await system.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM quest_contracts WHERE taken_by=$1 AND status='taken'`, [mgr],
  );
  if (Number(activeCnt.rows[0].c) >= limit) return { ok: false, error: `Максимум ${limit} активных контракта` };
  const lastFail = await system.query<{ ok: boolean }>(
    `SELECT (max(coalesce(done_at, deadline::timestamptz)) < now() - make_interval(hours => $2)) AS ok
       FROM quest_contracts WHERE taken_by=$1 AND status='failed'`,
    [mgr, cooldownH],
  );
  if (lastFail.rows[0] && lastFail.rows[0].ok === false) {
    return { ok: false, error: `После провала контракта — кулдаун ${cooldownH} ч` };
  }

  const client = await system.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query(`SELECT * FROM quest_contracts WHERE id=$1 AND status='open' FOR UPDATE`, [contractId]);
    if (c.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Контракт уже разобран' }; }
    const row = rowFromDb(c.rows[0]);
    const bal = await client.query<{ b: string }>(`SELECT coalesce(balance,0)::text AS b FROM badge_coin_balances WHERE bitrix_id=$1`, [mgr]);
    if (Number(bal.rows[0]?.b ?? 0) < row.deposit) {
      await client.query('ROLLBACK');
      return { ok: false, error: `Не хватает ебаллов на депозит (нужно ${row.deposit})` };
    }
    const led = await client.query<{ id: string }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, actor_login, comment)
       VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'contract_deposit', $3, $4) RETURNING id`,
      [mgr, -row.deposit, actorLogin, `Депозит контракта: ${row.title}`],
    );
    const upd = await client.query(
      `UPDATE quest_contracts SET status='taken', taken_by=$2, taken_at=now(),
         deadline=((now() AT TIME ZONE '${MSK}')::date + days), deposit_ledger_id=$3
       WHERE id=$1 RETURNING *`,
      [contractId, mgr, Number(led.rows[0].id)],
    );
    await client.query('COMMIT');
    // пополняем пул вместо взятого
    void ensureContractPool(system).catch(() => {});
    return { ok: true, contract: rowFromDb(upd.rows[0]) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── прогресс/зачёт/провал контрактов менеджера ───────────────────────────────

async function contractProgress(c: ContractRow): Promise<number> {
  const fromDay = c.takenAt ? new Date(c.takenAt).toLocaleDateString('sv-SE', { timeZone: MSK }) : mskToday();
  const res = await analyticsDb().query<{ sold_day: string; amount: string; grps: string[] | null; prev_grps: string[] | null }>(`
    WITH seq AS (
      SELECT d.deal_id, d.current_manager_id, d.sold_at, coalesce(d.amount,0) AS amount, dg.grps,
             LAG(dg.grps) OVER (PARTITION BY (CASE WHEN d.funnel_id IN (0,2) THEN 'c'||d.contact_id ELSE 'k'||d.company_id END)
                                ORDER BY d.sold_at, d.deal_id) AS prev_grps
      FROM sa.deals d
      CROSS JOIN LATERAL (
        SELECT array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
                     WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                       AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps
      ) dg
      WHERE d.sold_at IS NOT NULL AND d.funnel_id IN (0,1,2,3)
        AND (CASE WHEN d.funnel_id IN (0,2) THEN d.contact_id ELSE d.company_id END) IS NOT NULL
    )
    SELECT (sold_at AT TIME ZONE '${MSK}')::date::text AS sold_day, amount::text, grps, prev_grps
    FROM seq WHERE current_manager_id = $1 AND (sold_at AT TIME ZONE '${MSK}')::date >= $2::date
  `, [c.takenBy, fromDay]);
  const deals = res.rows.filter(d => c.deadline === null || d.sold_day <= c.deadline);
  switch (c.category) {
    case 'sales_count': return deals.length;
    case 'sales_amount': return deals.reduce((s, d) => s + Number(d.amount), 0);
    case 'group_sales': return deals.filter(d => c.targetGroup !== null && (d.grps ?? []).includes(c.targetGroup)).length;
    case 'crosssell': return deals.filter(d =>
      c.targetGroup !== null && (d.grps ?? []).includes(c.targetGroup)
      && c.pairFirst !== null && (d.prev_grps ?? []).includes(c.pairFirst)).length;
    case 'repeat_sales': return deals.length; // в пуле не генерится
    case 'distinct_groups': return new Set(deals.flatMap(d => d.grps ?? [])).size;
  }
}

export async function refreshContracts(system: Pool, mgr: number): Promise<{ mine: ContractRow[]; open: ContractRow[] }> {
  const today = mskToday();
  // Провал по дедлайну: депозит сгорает (0-строка-маркер в выписке для аудита).
  const failed = await system.query(
    `UPDATE quest_contracts SET status='failed' WHERE status='taken' AND deadline < $1 RETURNING id, taken_by, title, deposit`,
    [today],
  );
  for (const f of failed.rows as { taken_by: number; title: string; deposit: number }[]) {
    await system.query(
      `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, comment)
       VALUES ($1, NULL, NULL, 0, 0, 'EBALL', 'contract_deposit_burn', $2)`,
      [f.taken_by, `Депозит сгорел (−${f.deposit}): ${f.title}`],
    );
  }
  const mineQ = await system.query(`SELECT * FROM quest_contracts WHERE taken_by=$1 AND status='taken' ORDER BY deadline`, [mgr]);
  for (const raw of mineQ.rows) {
    const c = rowFromDb(raw);
    const progress = await contractProgress(c);
    if (progress >= c.target) {
      await completeContract(system, c, progress);
    } else if (progress !== c.progress) {
      await system.query(`UPDATE quest_contracts SET progress=$2 WHERE id=$1 AND status='taken'`, [c.id, progress]);
    }
  }
  const [mine, open] = await Promise.all([
    system.query(`SELECT * FROM quest_contracts WHERE taken_by=$1 AND (status='taken' OR (status IN ('done','failed') AND coalesce(done_at, created_at) > now() - interval '14 days')) ORDER BY status, deadline`, [mgr]),
    system.query(`SELECT * FROM quest_contracts WHERE status='open' AND week_start = $1 ORDER BY id`, [weekStartOf(today)]),
  ]);
  return { mine: mine.rows.map(rowFromDb), open: open.rows.map(rowFromDb) };
}

async function completeContract(system: Pool, c: ContractRow, progress: number): Promise<void> {
  const client = await system.connect();
  let loot: LootDrop | null = null;
  let completed = false;
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE quest_contracts SET status='done', progress=$2, done_at=now() WHERE id=$1 AND status='taken' RETURNING id`,
      [c.id, progress],
    );
    if (upd.rows.length > 0) {
      const led = await client.query<{ id: string }>(
        `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, comment)
         VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'quest', $3) RETURNING id`,
        [c.takenBy, c.rewardEballs, `Контракт выполнен: ${c.title}`],
      );
      await client.query(
        `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, comment)
         VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'contract_deposit_return', $3)`,
        [c.takenBy, c.deposit, `Возврат депозита: ${c.title}`],
      );
      loot = await rollLoot(client, c.takenBy!, c.tier);
      await client.query(
        `UPDATE quest_contracts SET coin_ledger_id=$2, meta = meta || $3::jsonb WHERE id=$1`,
        [c.id, Number(led.rows[0].id), JSON.stringify({ loot })],
      );
      await createNotification(client, {
        bitrixId: c.takenBy!, type: 'quest_done',
        title: `Контракт выполнен: ${c.title}`,
        body: `+${c.rewardEballs} ебаллов, +${c.rewardXp} XP, депозит ${c.deposit} вернулся.${loot ? ` Лутдроп: ${loot.itemName}!` : ''}`,
      });
      completed = true;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (completed) {
    void pushViaAnalitik(c.takenBy!, `📜 Контракт выполнен: ${c.title}`,
      `+${c.rewardEballs} ебаллов, +${c.rewardXp} XP, депозит вернулся.${loot ? ` 🎁 Лутдроп: ${loot.itemName}!` : ''}`);
  }
}

/** XP выполненных контрактов (для интеграции в уровень — как квестовый XP). */
export async function fetchContractXp(system: Pool | PoolClient): Promise<Map<number, number>> {
  try {
    const r = await system.query<{ b: number; xp: string }>(
      `SELECT taken_by::int AS b, sum(reward_xp)::text AS xp FROM quest_contracts WHERE status='done' GROUP BY 1`,
    );
    return new Map(r.rows.map(x => [x.b, Number(x.xp)]));
  } catch { return new Map(); }
}
