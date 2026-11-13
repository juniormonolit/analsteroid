// «Фильтр на колонке с автобраком» (владелец, собрание 12.11 п. 4+7, ответы 13.11; миграция 265).
// РОП в настройках колонки задаёт фильтр: видит «сколько останется / сколько уйдёт в брак» (заказчики, LTV, потенциал,
// список уходящих), жмёт «Применить» (двойное подтверждение) и/или ставит «Применять автоматически» (будни 8:00 МСК).
// Брак — тот же путь, что «Сразу в брак» (route.ts brak_now): отметка no_call (markBrakNow) + открытая повторная
// сделка → отказная стадия по причине правила (closeDealAsLost) + открытые задачи закрываются (closeTasksOnBrak).
// Идёт в фоне по одному с паузой (Битрикс — как можно реже). Журнал партий; откат партии — только снять брак
// (restoreFromBrak; сделки и задачи в Битриксе остаются закрытыми — решение владельца 13.11).
// Права: РОП и старше, РОП — в своей зоне (кандидаты считаются по доске его зоны).
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { BRAK_REASONS, COLUMNS } from './config';
import { cleanFilters, CustomColumnError, type CustomFilters } from './customColumns';
import type { BrakCandidate, BrakRuleCore } from './autoBrakTypes';

export class AutoBrakError extends Error {}
const PAUSE_MS = 400;
/** Предохранитель ежедневного автобрака: больше кандидатов за прогон правила — пропуск (13.11). */
const AUTO_CAP = 200;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const COLUMN_KEYS = new Set<string>(COLUMNS.filter(c => c.key !== 'brak' && c.key !== 'hidden').map(c => c.key));

export interface BrakRule extends BrakRuleCore { id: number; ownerUserId: string; ownerName: string | null; reason: string; comment: string | null; auto: boolean; updatedAt: string }
export interface BrakBatch {
  id: number; ruleId: number | null; column: string; mode: string; filters: CustomFilters; reason: string; auto: boolean;
  runByName: string | null; status: string; total: number; done: number; failed: number; ltv: number;
  startedAt: string; finishedAt: string | null; revertedAt: string | null; revertedBy: string | null;
}

/** Проверка правила из формы: колонка, режим, условия (как у своих колонок), причина — стадия отказа. */
export function cleanRule(body: Record<string, unknown>): BrakRuleCore & { reason: string; comment: string | null; auto: boolean } {
  const column = String(body.column ?? '');
  if (!COLUMN_KEYS.has(column)) throw new AutoBrakError('Колонка не поддерживает автобрак');
  const mode = body.mode === 'keep' ? 'keep' : 'brak';
  let filters: CustomFilters;
  try { filters = cleanFilters(body.filters); } catch (e) { throw new AutoBrakError(e instanceof CustomColumnError ? e.message : 'Некорректные условия'); }
  // Пустой фильтр = вся колонка в брак (с закрытием сделок в Битриксе) — такого правила не бывает (основная сессия, 13.11).
  const empty = Object.values(filters as Record<string, unknown>).every(v => v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0));
  if (empty) throw new AutoBrakError('Задайте хотя бы одно условие фильтра — без условий в брак ушла бы вся колонка');
  const reason = String(body.reason ?? '');
  if (!BRAK_REASONS.some(r => r.value === reason)) throw new AutoBrakError('Выберите причину брака');
  const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 500) : null;
  return { column, mode, filters, reason, comment, auto: body.auto === true };
}

interface RuleRow { id: string; owner_user_id: string; owner_name: string | null; column_key: string; mode: 'brak' | 'keep'; filters: CustomFilters; reason: string; comment: string | null; auto: boolean; updated_at: Date }
const toRule = (r: RuleRow): BrakRule => ({ id: Number(r.id), ownerUserId: r.owner_user_id, ownerName: r.owner_name, column: r.column_key, mode: r.mode, filters: r.filters ?? {}, reason: r.reason, comment: r.comment, auto: r.auto, updatedAt: new Date(r.updated_at).toISOString() });
const RULE_COLS = 'id::text, owner_user_id, owner_name, column_key, mode, filters, reason, comment, auto, updated_at';

/** Правила пользователя (по колонке — одно). До миграции — пусто. */
export async function fetchRules(userId: string): Promise<BrakRule[]> {
  try {
    const r = await systemDb().query<RuleRow>(`SELECT ${RULE_COLS} FROM repeat_brak_rules WHERE owner_user_id = $1 AND archived_at IS NULL ORDER BY id`, [userId]);
    return r.rows.map(toRule);
  } catch (e) {
    console.warn('[auto-brak rules]', e instanceof Error ? e.message : e);
    return [];
  }
}

export async function saveRule(session: SessionUser, body: Record<string, unknown>): Promise<BrakRule> {
  const v = cleanRule(body);
  const r = await systemDb().query<RuleRow>(
    `INSERT INTO repeat_brak_rules (owner_user_id, owner_name, column_key, mode, filters, reason, comment, auto)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (owner_user_id, column_key) WHERE archived_at IS NULL DO UPDATE SET owner_name = EXCLUDED.owner_name, mode = EXCLUDED.mode,
       filters = EXCLUDED.filters, reason = EXCLUDED.reason, comment = EXCLUDED.comment, auto = EXCLUDED.auto, updated_at = now()
     RETURNING ${RULE_COLS}`,
    [session.id, session.displayName, v.column, v.mode, JSON.stringify(v.filters), v.reason, v.comment, v.auto]);
  return toRule(r.rows[0]);
}

export async function deleteRule(session: SessionUser, column: string): Promise<void> {
  await systemDb().query(`UPDATE repeat_brak_rules SET archived_at = now() WHERE owner_user_id = $1 AND column_key = $2 AND archived_at IS NULL`, [session.id, column]);
}

/** РОП и старше: в зоне есть кто-то кроме самого себя (как canManage доски). */
export async function canAutoBrak(session: SessionUser): Promise<boolean> {
  const scope = await ropScope(session).catch(() => null);
  if (!scope) return false;
  if (scope.full) return true;
  if (scope.selfOnly) return false;
  const managers = await scopeManagers(scope).catch(() => []);
  return managers.some(m => m.id !== session.bitrixUserId);
}

/** Все кандидаты правила по доске зоны пользователя, без фильтров доски. */
export async function collectCandidates(session: SessionUser, rule: BrakRuleCore): Promise<BrakCandidate[]> {
  const { buildRepeatBoard } = await import('./board');
  const scope = await ropScope(session);
  const managers = await scopeManagers(scope);
  const board = await buildRepeatBoard({ managers, selectedManagers: [], typeFilter: null, canManage: true, skipNames: true, viewerUserId: session.id, brakCollect: rule });
  return board.brakAll ?? [];
}

const running = new Set<number>();

/** Создать партию и брак в фоне. Возвращает id партии (статус — fetchBatches). */
export async function startBatch(session: SessionUser, rule: BrakRuleCore & { reason: string; comment: string | null }, ruleId: number | null, auto: boolean, cands: BrakCandidate[]): Promise<number> {
  const db = systemDb();
  const b = await db.query<{ id: string }>(
    `INSERT INTO repeat_brak_batches (rule_id, column_key, mode, filters, reason, auto, run_by, run_by_name, total, ltv)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10) RETURNING id::text`,
    [ruleId, rule.column, rule.mode, JSON.stringify(rule.filters), rule.reason, auto, session.id, session.displayName, cands.length, cands.reduce((s, c) => s + c.ltv, 0)]);
  const batchId = Number(b.rows[0].id);
  if (cands.length) {
    await db.query(
      `INSERT INTO repeat_brak_batch_items (batch_id, client_key, manager_id, name, ltv, deal_id)
       SELECT $1, k, m, n, l, d FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::bigint[]) AS x(k, m, n, l, d)
       ON CONFLICT DO NOTHING`,
      [batchId, cands.map(c => c.clientKey), cands.map(c => c.managerId), cands.map(c => c.name), cands.map(c => c.ltv), cands.map(c => (c.dealOpen ? c.dealId : null))]);
  }
  void runBatch(batchId, session, rule, cands);
  return batchId;
}

async function runBatch(batchId: number, session: SessionUser, rule: BrakRuleCore & { reason: string; comment: string | null }, cands: BrakCandidate[]): Promise<void> {
  running.add(batchId);
  const db = systemDb();
  const { markBrakNow } = await import('./reviews');
  const { closeDealAsLost } = await import('./createDeal');
  const { closeTasksOnBrak } = await import('./taskReview');
  const { logEvent, newRequestId } = await import('./log');
  const label = BRAK_REASONS.find(r => r.value === rule.reason)?.label ?? rule.reason;
  const comment = `Автобрак по фильтру колонки «${COLUMNS.find(c => c.key === rule.column)?.title ?? rule.column}» (партия ${batchId})${rule.comment ? ` — ${rule.comment}` : ''}`;
  let done = 0, failed = 0;
  try {
    for (const c of cands) {
      try {
        await markBrakNow({ clientKey: c.clientKey, reason: rule.reason, comment, session });
        const dealClosed = c.dealOpen && c.dealId
          ? await closeDealAsLost({ dealId: c.dealId, clientKey: c.clientKey, reason: rule.reason, comment, authorId: session.bitrixUserId }).catch(e => `error: ${e instanceof Error ? e.message : e}`)
          : null;
        const tasks = await closeTasksOnBrak({ clientKey: c.clientKey, authorId: session.bitrixUserId, reason: label, comment });
        await db.query(`UPDATE repeat_brak_batch_items SET ok = true, deal_closed = $3, tasks_closed = $4 WHERE batch_id = $1 AND client_key = $2`,
          [batchId, c.clientKey, dealClosed, tasks.closed.length]);
        await logEvent(session, { type: 'rejected_direct', requestId: newRequestId(), clientKey: c.clientKey, managerId: c.managerId, columnBefore: rule.column, dealId: c.dealId,
          payload: { reason: rule.reason, comment, dealClosed, taskClosed: tasks, autoBrakBatch: batchId } });
        done++;
      } catch (e) {
        failed++;
        await db.query(`UPDATE repeat_brak_batch_items SET ok = false, error = $3 WHERE batch_id = $1 AND client_key = $2`,
          [batchId, c.clientKey, (e instanceof Error ? e.message : String(e)).slice(0, 500)]).catch(() => {});
      }
      await db.query(`UPDATE repeat_brak_batches SET done = $2, failed = $3 WHERE id = $1`, [batchId, done, failed]).catch(() => {});
      await sleep(PAUSE_MS);
    }
    await db.query(`UPDATE repeat_brak_batches SET status = 'done', finished_at = now(), done = $2, failed = $3 WHERE id = $1`, [batchId, done, failed]);
  } catch (e) {
    console.error(`[auto-brak] партия ${batchId} упала:`, e instanceof Error ? e.message : e);
    await db.query(`UPDATE repeat_brak_batches SET status = 'failed', finished_at = now() WHERE id = $1`, [batchId]).catch(() => {});
  } finally {
    running.delete(batchId);
  }
}

interface BatchRow { id: string; rule_id: string | null; column_key: string; mode: string; filters: CustomFilters; reason: string; auto: boolean; run_by_name: string | null; status: string; total: number; done: number; failed: number; ltv: string; started_at: Date; finished_at: Date | null; reverted_at: Date | null; reverted_by: string | null }
const toBatch = (r: BatchRow): BrakBatch => ({
  id: Number(r.id), ruleId: r.rule_id ? Number(r.rule_id) : null, column: r.column_key, mode: r.mode, filters: r.filters, reason: r.reason, auto: r.auto,
  runByName: r.run_by_name, status: r.status, total: r.total, done: r.done, failed: r.failed, ltv: Math.round(Number(r.ltv)),
  startedAt: new Date(r.started_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  revertedAt: r.reverted_at ? new Date(r.reverted_at).toISOString() : null, revertedBy: r.reverted_by,
});

/** Журнал: партии пользователя (по колонке или все), свежие сверху. */
export async function fetchBatches(userId: string, column?: string | null, limit = 30): Promise<BrakBatch[]> {
  try {
    const r = await systemDb().query<BatchRow>(
      `SELECT id::text, rule_id::text, column_key, mode, filters, reason, auto, run_by_name, status, total, done, failed, ltv::text, started_at, finished_at, reverted_at, reverted_by
         FROM repeat_brak_batches WHERE run_by = $1 ${column ? 'AND column_key = $3' : ''} ORDER BY started_at DESC LIMIT $2`,
      column ? [userId, limit, column] : [userId, limit]);
    return r.rows.map(toBatch);
  } catch { return []; }
}

export async function fetchBatchItems(userId: string, batchId: number): Promise<{ clientKey: string; name: string | null; ltv: number; ok: boolean | null; dealClosed: string | null; tasksClosed: number | null; error: string | null }[]> {
  const r = await systemDb().query<{ client_key: string; name: string | null; ltv: string | null; ok: boolean | null; deal_closed: string | null; tasks_closed: number | null; error: string | null }>(
    `SELECT i.client_key, i.name, i.ltv::text, i.ok, i.deal_closed, i.tasks_closed, i.error FROM repeat_brak_batch_items i
       JOIN repeat_brak_batches b ON b.id = i.batch_id WHERE i.batch_id = $1 AND b.run_by = $2 ORDER BY i.ltv DESC NULLS LAST`, [batchId, userId]);
  return r.rows.map(x => ({ clientKey: x.client_key, name: x.name, ltv: Math.round(Number(x.ltv ?? 0)), ok: x.ok, dealClosed: x.deal_closed, tasksClosed: x.tasks_closed, error: x.error }));
}

/** Откат партии — только снять брак (сделки и задачи в Битриксе остаются закрытыми). Только своя партия, один раз. */
export async function revertBatch(session: SessionUser, batchId: number): Promise<number> {
  const db = systemDb();
  if (running.has(batchId)) throw new AutoBrakError('Партия ещё идёт — дождитесь окончания');
  const b = await db.query<{ reverted_at: Date | null }>(`SELECT reverted_at FROM repeat_brak_batches WHERE id = $1 AND run_by = $2`, [batchId, session.id]);
  if (!b.rows[0]) throw new AutoBrakError('Партия не найдена или не ваша');
  if (b.rows[0].reverted_at) throw new AutoBrakError('Партию уже откатили');
  const items = await db.query<{ client_key: string }>(`SELECT client_key FROM repeat_brak_batch_items WHERE batch_id = $1 AND ok`, [batchId]);
  const { restoreFromBrak } = await import('./reviews');
  for (const it of items.rows) await restoreFromBrak(it.client_key, session);
  await db.query(`UPDATE repeat_brak_batches SET reverted_at = now(), reverted_by = $2 WHERE id = $1`, [batchId, session.displayName]);
  return items.rows.length;
}

/** Ночной прогон (будни 8:00 МСК, instrumentation.ts): каждое правило с авто — от имени его автора, по его зоне. */
export async function runAutoBrakDaily(): Promise<{ rules: number; batches: number; customers: number }> {
  const r = await systemDb().query<RuleRow>(`SELECT ${RULE_COLS} FROM repeat_brak_rules WHERE auto AND archived_at IS NULL ORDER BY id`).catch(() => ({ rows: [] as RuleRow[] }));
  const { loadSessionUserById } = await import('@/lib/auth/session');
  let batches = 0, customers = 0;
  for (const row of r.rows) {
    const rule = toRule(row);
    try {
      const session = await loadSessionUserById(rule.ownerUserId);
      if (!session || !(await canAutoBrak(session))) continue;
      const cands = await collectCandidates(session, rule);
      if (!cands.length) continue;
      // Предохранитель авто: за утро по правилу — не больше AUTO_CAP; больше — не трогаем, РОП применит руками, глядя на список.
      if (cands.length > AUTO_CAP) {
        console.warn(`[auto-brak] правило ${rule.id} (${rule.column}): ${cands.length} кандидатов > ${AUTO_CAP} — автобрак пропущен, нужен ручной «Применить»`);
        continue;
      }
      const id = await startBatch(session, rule, rule.id, true, cands);
      batches++; customers += cands.length;
      // Партии по очереди: следующая — когда эта закончится (Битрикс вежливо).
      while (running.has(id)) await sleep(5000);
    } catch (e) {
      console.error(`[auto-brak] правило ${rule.id} не прогналось:`, e instanceof Error ? e.message : e);
    }
  }
  return { rules: r.rows.length, batches, customers };
}
