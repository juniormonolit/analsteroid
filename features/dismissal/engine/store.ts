// БД «Увольнятора» (миграция 287, monolitika через systemDb): прогоны, строки, переходы статусов.
import { systemDb } from '@/lib/db/clients';
import {
  DISMISSAL_KINDS, type DismissalCounts, type DismissalItem, type DismissalKind, type DismissalPlan,
  type DismissalRunDetail, type DismissalRunStatus, type DismissalRunSummary, type DismissalUser,
} from '../types';
import { defaultPlan, expandDepartments, resolvePlan, sanitizePlan } from './plan';
import type { ScannedItem } from './scan';
import { departmentName, departmentTargets, userNameMap } from './users';

export class DismissalError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

interface RunRow {
  id: string; source_bitrix_id: string; source: DismissalUser; status: DismissalRunStatus; plan: DismissalPlan;
  created_by: string | null; created_by_name: string; created_by_bitrix_id: string | null;
  created_at: Date; started_at: Date | null; finished_at: Date | null; error: string | null;
}
interface CountRow { run_id: string; kind: string; status: string; n: number }

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const KINDS = DISMISSAL_KINDS as readonly string[];

function emptyCounts(): DismissalCounts { return { total: 0, pending: 0, done: 0, skipped: 0, error: 0, byKind: {} }; }

async function countsFor(ids: string[]): Promise<Map<string, DismissalCounts>> {
  const out = new Map<string, DismissalCounts>(ids.map(id => [id, emptyCounts()]));
  if (!ids.length) return out;
  const r = await systemDb().query<CountRow>(
    `SELECT run_id::text, kind, status, count(*)::int AS n FROM dismissal_items WHERE run_id = ANY($1::uuid[]) GROUP BY 1, 2, 3`, [ids],
  );
  for (const row of r.rows) {
    const c = out.get(row.run_id)!;
    c.total += row.n;
    if (row.status === 'pending' || row.status === 'done' || row.status === 'skipped' || row.status === 'error') c[row.status] += row.n;
    const k = row.kind as DismissalKind;
    c.byKind[k] = (c.byKind[k] ?? 0) + row.n;
  }
  return out;
}

function summaryOf(r: RunRow, counts: DismissalCounts): DismissalRunSummary {
  return {
    id: r.id, source: r.source, status: r.status, createdByName: r.created_by_name,
    createdAt: iso(r.created_at)!, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), counts, error: r.error,
  };
}

const RUN_COLS = `id::text, source_bitrix_id::text, source, status, plan, created_by, created_by_name, created_by_bitrix_id::text,
                  created_at, started_at, finished_at, error`;

export async function getRunRow(id: string): Promise<RunRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await systemDb().query<RunRow>(`SELECT ${RUN_COLS} FROM dismissal_runs WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function listRuns(limit = 100): Promise<DismissalRunSummary[]> {
  const r = await systemDb().query<RunRow>(`SELECT ${RUN_COLS} FROM dismissal_runs ORDER BY created_at DESC LIMIT $1`, [limit]);
  const counts = await countsFor(r.rows.map(x => x.id));
  return r.rows.map(x => summaryOf(x, counts.get(x.id) ?? emptyCounts()));
}

export async function getRunDetail(id: string): Promise<DismissalRunDetail | null> {
  const run = await getRunRow(id);
  if (!run) return null;
  const r = await systemDb().query<{
    key: string; kind: DismissalKind; entity_id: string; title: string; url: string | null; subtitle: string | null;
    action: DismissalItem['action']; target: string | null; status: DismissalItem['status']; detail: string | null; done_at: Date | null;
  }>(
    `SELECT key, kind, entity_id::text, title, url, subtitle, action, target::text, status, detail, done_at
       FROM dismissal_items WHERE run_id = $1 ORDER BY array_position($2::text[], kind), ord`, [id, KINDS],
  );
  const items: DismissalItem[] = r.rows.map(x => ({
    key: x.key, kind: x.kind, entityId: Number(x.entity_id), title: x.title, url: x.url, subtitle: x.subtitle,
    action: x.action, target: x.target ? Number(x.target) : null, status: x.status, detail: x.detail, doneAt: iso(x.done_at),
  }));
  const counts = (await countsFor([id])).get(id) ?? emptyCounts();
  const ids = new Set<number>([Number(run.source_bitrix_id)]);
  for (const rule of Object.values(run.plan.rules ?? {})) for (const t of rule?.targets ?? []) ids.add(t);
  for (const o of Object.values(run.plan.overrides ?? {})) if (o?.target) ids.add(o.target);
  for (const it of items) if (it.target) ids.add(it.target);
  return { ...summaryOf(run, counts), plan: run.plan, items, userNames: await userNameMap(ids) };
}

/** Активный (незавершённый) прогон по этому сотруднику — второй не заводим. */
export async function activeRunFor(sourceId: number): Promise<string | null> {
  const r = await systemDb().query<{ id: string }>(
    `SELECT id::text FROM dismissal_runs WHERE source_bitrix_id = $1 AND status IN ('scanning', 'draft', 'queued', 'running', 'paused')
      ORDER BY created_at DESC LIMIT 1`, [sourceId],
  );
  return r.rows[0]?.id ?? null;
}

export async function createRun(source: DismissalUser, by: { login: string; name: string; bitrixId: number | null }): Promise<string> {
  const r = await systemDb().query<{ id: string }>(
    `INSERT INTO dismissal_runs (source_bitrix_id, source, status, plan, created_by, created_by_name, created_by_bitrix_id)
     VALUES ($1, $2, 'scanning', $3, $4, $5, $6) RETURNING id::text`,
    [source.bitrixId, JSON.stringify(source), JSON.stringify(defaultPlan()), by.login, by.name, by.bitrixId],
  );
  return r.rows[0].id;
}

async function itemKinds(id: string): Promise<Map<string, DismissalKind>> {
  const r = await systemDb().query<{ key: string; kind: DismissalKind }>('SELECT key, kind FROM dismissal_items WHERE run_id = $1', [id]);
  return new Map(r.rows.map(x => [x.key, x.kind]));
}

export async function savePlan(id: string, raw: unknown): Promise<void> {
  const run = await getRunRow(id);
  if (!run) throw new DismissalError('Прогон не найден', 404);
  if (run.status !== 'draft') throw new DismissalError('Правила меняются только до запуска (в черновике)', 409);
  const res = sanitizePlan(raw, await itemKinds(id));
  if ('error' in res) throw new DismissalError(res.error);
  await systemDb().query(`UPDATE dismissal_runs SET plan = $2, updated_at = now() WHERE id = $1 AND status = 'draft'`, [id, JSON.stringify(res.plan)]);
}

/** «Готово»: draft → queued. Разворачивает план в строки (action/target); skip сразу в skipped. */
export async function startRun(id: string): Promise<void> {
  const run = await getRunRow(id);
  if (!run) throw new DismissalError('Прогон не найден', 404);
  if (run.status !== 'draft') throw new DismissalError('Запустить можно только черновик', 409);
  const r = await systemDb().query<{ key: string; kind: DismissalKind; ord: number }>('SELECT key, kind, ord FROM dismissal_items WHERE run_id = $1', [id]);
  if (!r.rows.length) throw new DismissalError('На аккаунте ничего не найдено — исполнять нечего');
  const sourceId = Number(run.source_bitrix_id);
  // «Раскидать по отделу» — состав отдела на момент «Готово».
  const exp = await expandDepartments(run.plan, dep => departmentTargets(dep, sourceId));
  const res = resolvePlan(exp.plan, r.rows, sourceId);
  // Журнал «раскидали по отделу»: в строку — название отдела (если получатель из правила, а не из исключения),
  // в план — фактический состав отдела на момент запуска (targets рядом с departmentId).
  const depName: Partial<Record<DismissalKind, string>> = {};
  for (const [k, rule] of Object.entries(exp.plan.rules)) {
    if (rule?.departmentId && rule.action === 'transfer') depName[k as DismissalKind] = await departmentName(rule.departmentId);
  }
  const kindOf = new Map(r.rows.map(x => [x.key, x.kind]));
  const resolved = res.resolved.map(x => {
    const kind = kindOf.get(x.key)!;
    const viaDep = x.action === 'transfer' && !exp.plan.overrides[x.key]?.target ? depName[kind] ?? null : null;
    return { ...x, via_department: viaDep };
  });
  const problems = [...exp.problems, ...res.problems];
  if (problems.length) throw new DismissalError(`План не готов: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? ` и ещё ${problems.length - 10}` : ''}`);
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(`SELECT 1 FROM dismissal_runs WHERE id = $1 AND status = 'draft' FOR UPDATE`, [id]);
    if (!lock.rowCount) throw new DismissalError('Прогон уже не в черновике', 409);
    await client.query(
      `UPDATE dismissal_items i SET action = x.action, target = x.target,
              status = CASE WHEN x.action = 'skip' THEN 'skipped' ELSE 'pending' END,
              detail = CASE WHEN x.action = 'skip' THEN 'По правилу: не трогать' ELSE NULL END,
              done_at = NULL, attempts = 0,
              meta = CASE WHEN x.via_department IS NULL THEN i.meta - 'viaDepartment'
                          ELSE i.meta || jsonb_build_object('viaDepartment', x.via_department) END
         FROM jsonb_to_recordset($2::jsonb) AS x(key text, action text, target bigint, via_department text)
        WHERE i.run_id = $1 AND i.key = x.key`,
      [id, JSON.stringify(resolved)],
    );
    await client.query(`UPDATE dismissal_runs SET status = 'queued', plan = $2, error = NULL, locked_by = NULL, updated_at = now() WHERE id = $1`, [id, JSON.stringify(exp.plan)]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Переход статуса из разрешённых. Возвращает false, если прогон не в нужном статусе. */
async function transition(id: string, from: DismissalRunStatus[], to: DismissalRunStatus, extra = ''): Promise<boolean> {
  const r = await systemDb().query(
    `UPDATE dismissal_runs SET status = $3, updated_at = now()${extra} WHERE id = $1 AND status = ANY($2::text[])`, [id, from, to],
  );
  return (r.rowCount ?? 0) > 0;
}

const STATUS_RU: Record<DismissalRunStatus, string> = {
  scanning: 'сбор', draft: 'черновик', queued: 'в очереди', running: 'исполняется', paused: 'на паузе', done: 'завершён', failed: 'ошибка', cancelled: 'отменён',
};

export async function runAction(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'rescan'): Promise<void> {
  const run = await getRunRow(id);
  if (!run) throw new DismissalError('Прогон не найден', 404);
  let ok = false;
  if (action === 'pause') ok = await transition(id, ['queued', 'running'], 'paused');
  else if (action === 'resume') ok = await transition(id, ['paused'], 'queued');
  else if (action === 'cancel') ok = await transition(id, ['scanning', 'draft', 'queued', 'running', 'paused'], 'cancelled', ', finished_at = now()');
  else if (action === 'rescan') {
    // Пересобрать можно черновик и прогон, упавший на сборе (до запуска).
    ok = run.status === 'draft' || (run.status === 'failed' && !run.started_at)
      ? await transition(id, ['draft', 'failed'], 'scanning', ', error = NULL, locked_by = NULL')
      : false;
  } else if (action === 'retry') {
    if (!['done', 'paused', 'failed'].includes(run.status) || !run.started_at) throw new DismissalError(`Повтор ошибок недоступен: прогон ${STATUS_RU[run.status]}`, 409);
    const n = await systemDb().query(
      `UPDATE dismissal_items SET status = 'pending', attempts = 0, detail = NULL, done_at = NULL WHERE run_id = $1 AND status = 'error'`, [id],
    );
    if (!n.rowCount && run.status !== 'paused') throw new DismissalError('Строк с ошибкой нет', 409);
    ok = await transition(id, ['done', 'paused', 'failed'], 'queued', ', finished_at = NULL, error = NULL');
  }
  if (!ok) throw new DismissalError(`Действие недоступно: прогон ${STATUS_RU[run.status]}`, 409);
}

// ── Для воркера ─────────────────────────────────────────────────────────────

export interface ClaimedRun { id: string; status: DismissalRunStatus; sourceId: number; plan: DismissalPlan; createdByBitrixId: number | null; source: DismissalUser }

/** Захват прогона: свой, свободный или с протухшим heartbeat (процесс умер/деплой). queued → running. */
export async function claimRun(workerId: string, staleSec: number): Promise<ClaimedRun | null> {
  const r = await systemDb().query<{ id: string; status: DismissalRunStatus; source_bitrix_id: string; plan: DismissalPlan; created_by_bitrix_id: string | null; source: DismissalUser }>(
    `UPDATE dismissal_runs r
        SET locked_by = $1, heartbeat_at = now(), updated_at = now(),
            status = CASE WHEN r.status = 'queued' THEN 'running' ELSE r.status END,
            started_at = CASE WHEN r.status = 'queued' THEN coalesce(r.started_at, now()) ELSE r.started_at END
      WHERE r.id = (
        SELECT id FROM dismissal_runs
         WHERE status IN ('scanning', 'queued', 'running')
           AND (locked_by IS NULL OR locked_by = $1 OR heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $2))
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING r.id::text, r.status, r.source_bitrix_id::text, r.plan, r.created_by_bitrix_id::text, r.source`,
    [workerId, staleSec],
  );
  const x = r.rows[0];
  return x ? { id: x.id, status: x.status, sourceId: Number(x.source_bitrix_id), plan: x.plan, createdByBitrixId: x.created_by_bitrix_id ? Number(x.created_by_bitrix_id) : null, source: x.source } : null;
}

export async function heartbeat(id: string, workerId: string): Promise<void> {
  await systemDb().query('UPDATE dismissal_runs SET heartbeat_at = now() WHERE id = $1 AND locked_by = $2', [id, workerId]);
}
export async function release(id: string, workerId: string): Promise<void> {
  await systemDb().query('UPDATE dismissal_runs SET locked_by = NULL, heartbeat_at = NULL WHERE id = $1 AND locked_by = $2', [id, workerId]);
}
export async function runStatus(id: string): Promise<DismissalRunStatus | null> {
  const r = await systemDb().query<{ status: DismissalRunStatus }>('SELECT status FROM dismissal_runs WHERE id = $1', [id]);
  return r.rows[0]?.status ?? null;
}

/** Итог сбора: строки целиком заменяются (до запуска исполнять нечего), исключения по исчезнувшим строкам отбрасываются. */
export async function saveScan(id: string, workerId: string, items: ScannedItem[], plan: DismissalPlan): Promise<boolean> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(`SELECT 1 FROM dismissal_runs WHERE id = $1 AND status = 'scanning' AND locked_by = $2 FOR UPDATE`, [id, workerId]);
    if (!lock.rowCount) { await client.query('ROLLBACK'); return false; } // отменили/перехватили во время сбора
    await client.query('DELETE FROM dismissal_items WHERE run_id = $1', [id]);
    for (let i = 0; i < items.length; i += 500) {
      const chunk = items.slice(i, i + 500).map(x => ({ key: x.key, kind: x.kind, ord: x.ord, entity_id: x.entityId, title: x.title.slice(0, 500), url: x.url, subtitle: x.subtitle, meta: x.meta }));
      await client.query(
        `INSERT INTO dismissal_items (run_id, key, kind, ord, entity_id, title, url, subtitle, meta)
         SELECT $1, key, kind, ord, entity_id, title, url, subtitle, coalesce(meta, '{}')
           FROM jsonb_to_recordset($2::jsonb) AS x(key text, kind text, ord int, entity_id bigint, title text, url text, subtitle text, meta jsonb)
         ON CONFLICT (run_id, key) DO NOTHING`,
        [id, JSON.stringify(chunk)],
      );
    }
    const keys = new Set(items.map(x => x.key));
    const base = plan?.rules && Object.keys(plan.rules).length ? plan : defaultPlan();
    const cleaned: DismissalPlan = { ...base, overrides: Object.fromEntries(Object.entries(base.overrides ?? {}).filter(([k]) => keys.has(k))) };
    await client.query(
      `UPDATE dismissal_runs SET status = 'draft', plan = $2, error = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(cleaned)],
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function failRun(id: string, workerId: string, error: string): Promise<void> {
  await systemDb().query(
    `UPDATE dismissal_runs SET status = 'failed', error = $3, finished_at = now(), locked_by = NULL, heartbeat_at = NULL, updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status IN ('scanning', 'running')`, [id, workerId, error.slice(0, 2000)],
  );
}

export interface PendingItem { key: string; kind: DismissalKind; entityId: number; action: DismissalItem['action']; target: number | null; meta: Record<string, unknown>; attempts: number }
export async function nextPending(id: string): Promise<PendingItem | null> {
  const r = await systemDb().query<{ key: string; kind: DismissalKind; entity_id: string; action: DismissalItem['action']; target: string | null; meta: Record<string, unknown>; attempts: number }>(
    `SELECT key, kind, entity_id::text, action, target::text, meta, attempts FROM dismissal_items
      WHERE run_id = $1 AND status = 'pending' ORDER BY array_position($2::text[], kind), ord LIMIT 1`, [id, KINDS],
  );
  const x = r.rows[0];
  return x ? { key: x.key, kind: x.kind, entityId: Number(x.entity_id), action: x.action, target: x.target ? Number(x.target) : null, meta: x.meta ?? {}, attempts: x.attempts } : null;
}

export async function finishItem(id: string, key: string, status: 'done' | 'skipped' | 'error', detail: string): Promise<void> {
  await systemDb().query(
    `UPDATE dismissal_items SET status = $3, detail = $4, attempts = attempts + 1, done_at = now() WHERE run_id = $1 AND key = $2`,
    [id, key, status, detail.slice(0, 1000)],
  );
}
export async function deferItem(id: string, key: string, detail: string): Promise<number> {
  const r = await systemDb().query<{ attempts: number }>(
    `UPDATE dismissal_items SET attempts = attempts + 1, detail = $3 WHERE run_id = $1 AND key = $2 RETURNING attempts`, [id, key, detail.slice(0, 1000)],
  );
  return r.rows[0]?.attempts ?? 0;
}

/** Прогон исполнен: running → done. false — его успели поставить на паузу/отменить. */
export async function completeRun(id: string, workerId: string): Promise<boolean> {
  const r = await systemDb().query(
    `UPDATE dismissal_runs SET status = 'done', finished_at = now(), locked_by = NULL, heartbeat_at = NULL, updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`, [id, workerId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function runCounts(id: string): Promise<DismissalCounts> {
  return (await countsFor([id])).get(id) ?? emptyCounts();
}
