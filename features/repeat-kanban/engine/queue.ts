// Очередь задач канбана повторных (миграция 237; владелец 22.10: «РОП разбирает хоть всех заказчиков,
// но задачи и сделки не сыплются на менеджера сразу, а ставятся по очереди с интервалом, по срочности»;
// план — консультация Fable).
//
// Позиция = заказчик → менеджер. Фоновый джоб repeatQueueIssue (раз в 2 мин, рабочие часы МСК) выдаёт
// «до нормы»: активных задач менеджера (проект «Повторные продажи», статусы 1–3) < manager_task_limit и
// выдано из очереди сегодня < queue_daily_limit; за прогон — не больше одной позиции на менеджера и пяти
// всего (темп и лимит запросов Битрикса). Порядок — score в момент выдачи по свежей доске менеджера
// (окно, потенциал, последняя сделка, «вернулся сам», тип клиента, ручной буст). Та же доска снимает
// позиции, которые больше не нужны: открылась сделка / брак / скрыт / заказчик ушёл к другому менеджеру.
// Текст задачи — шаблон в момент выдачи + комментарий РОПа; постановщик — тот, кто поставил в очередь.
// Идемпотентность: queued → issuing (UPDATE … WHERE status='queued') → createRepeatTask → issued. Зависшее
// в issuing (процесс упал посреди Битрикса) не повторяется само — failed «проверьте вручную».
import { systemDb } from '@/lib/db/clients';
import { buildRepeatBoard, fetchManagerLoad, type KanbanCard } from './board';
import { createRepeatTask, DealCreateError } from './createDeal';
import { fetchKanbanSettings, getTemplate, renderTemplate } from './settings';
import { newRequestId } from './log';
import { WINDOW_DAYS } from './config';
import { rememberDealClient } from './dealFixes';
import { normalizeParticipants, type TaskParticipants } from './participants';

export type QueueStatus = 'queued' | 'issuing' | 'issued' | 'removed' | 'failed';
export type DeadlineRule = 'window' | 'today' | '3' | '7';

export interface QueueItem {
  id: number; clientKey: string; managerId: string; newResponsibleId: string | null;
  queuedBy: string; queuedByName: string | null; templateId: number | null; comment: string | null;
  deadlineRule: DeadlineRule; deadlineTime: string; boost: number; status: QueueStatus;
  score: number | null; scoreAt: string | null; lastError: string | null;
  issuedTaskId: number | null; issuedDealId: number | null; issuedAt: string | null;
  removedReason: string | null; removedAt: string | null; createdAt: string;
  /** Соисполнители/наблюдатели (миграция 254) — применяются при выдаче. */
  participants: TaskParticipants | null;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
function rowToItem(x: Record<string, unknown>): QueueItem {
  return {
    id: Number(x.id), clientKey: String(x.client_key), managerId: String(x.manager_id),
    newResponsibleId: (x.new_responsible_id as string | null) ?? null,
    queuedBy: String(x.queued_by), queuedByName: (x.queued_by_name as string | null) ?? null,
    templateId: x.template_id !== null && x.template_id !== undefined ? Number(x.template_id) : null,
    comment: (x.comment as string | null) ?? null,
    deadlineRule: x.deadline_rule as DeadlineRule, deadlineTime: String(x.deadline_time ?? '19:00'),
    boost: Number(x.boost ?? 0), status: x.status as QueueStatus,
    score: x.score !== null && x.score !== undefined ? Number(x.score) : null, scoreAt: iso(x.score_at),
    lastError: (x.last_error as string | null) ?? null,
    issuedTaskId: x.issued_task_id ? Number(x.issued_task_id) : null, issuedDealId: x.issued_deal_id ? Number(x.issued_deal_id) : null,
    issuedAt: iso(x.issued_at), removedReason: (x.removed_reason as string | null) ?? null, removedAt: iso(x.removed_at),
    createdAt: iso(x.created_at)!,
    participants: normalizeParticipants(x.participants),
  };
}

// ── Журнал: события очереди пишутся от имени поставившего (РОПа) — его действие, отложенное. ──
async function logQueue(type: string, item: { clientKey: string; managerId: string; queuedBy: string; queuedByName: string | null }, extra: { dealId?: number | null; taskId?: number | null; payload?: Record<string, unknown> } = {}) {
  await systemDb().query(
    `INSERT INTO repeat_kanban_events (request_id, actor_type, actor_login, actor_name, actor_bitrix_id, actor_role,
                                       event_type, client_key, manager_id, column_before, deal_id, task_id, payload)
     VALUES ($1, 'user', NULL, $2, $3, NULL, $4, $5, $6, NULL, $7, $8, $9)`,
    [newRequestId(), item.queuedByName, item.queuedBy, type, item.clientKey, item.managerId, extra.dealId ?? null, extra.taskId ?? null,
     JSON.stringify({ via: 'queue', ...(extra.payload ?? {}) })],
  ).catch(e => console.warn('[repeat-queue] журнал:', e instanceof Error ? e.message : e));
}

// ── Постановка ────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  items: { clientKey: string; managerId: string }[];
  queuedBy: string; queuedByName: string | null;
  templateId: number | null; comment: string | null;
  deadlineRule: DeadlineRule; deadlineTime: string; newResponsibleId: string | null; boost?: number;
  participants?: TaskParticipants | null;
}

/** Поставить в очередь. Живая позиция заказчика уже есть — обновляется (менеджер, шаблон, срок,
 *  комментарий), поставивший остаётся первым. */
export async function enqueue(input: EnqueueInput): Promise<{ added: number; updated: number }> {
  const db = systemDb();
  let added = 0, updated = 0;
  for (const it of input.items) {
    const target = input.newResponsibleId ?? it.managerId;
    const r = await db.query(
      `UPDATE repeat_task_queue SET manager_id = $2, new_responsible_id = $3, template_id = $4, comment = $5,
              deadline_rule = $6, deadline_time = $7, boost = coalesce($8, boost), participants = $9, updated_at = now()
        WHERE client_key = $1 AND status = 'queued' RETURNING id`,
      [it.clientKey, target, input.newResponsibleId, input.templateId, input.comment, input.deadlineRule, input.deadlineTime, input.boost ?? null,
       input.participants ? JSON.stringify(input.participants) : null],
    );
    if (r.rowCount) { updated++; continue; }
    const ins = await db.query(
      `INSERT INTO repeat_task_queue (client_key, manager_id, new_responsible_id, queued_by, queued_by_name, template_id, comment,
                                      deadline_rule, deadline_time, boost, participants)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING RETURNING id`,
      [it.clientKey, target, input.newResponsibleId, input.queuedBy, input.queuedByName, input.templateId, input.comment,
       input.deadlineRule, input.deadlineTime, input.boost ?? 0, input.participants ? JSON.stringify(input.participants) : null],
    );
    if (ins.rowCount) {
      added++;
      await logQueue('queue_added', { clientKey: it.clientKey, managerId: target, queuedBy: input.queuedBy, queuedByName: input.queuedByName },
        { payload: { deadlineRule: input.deadlineRule, templateId: input.templateId, comment: input.comment, newResponsibleId: input.newResponsibleId } });
    }
  }
  return { added, updated };
}

export async function removeFromQueue(id: number, reason: string, by: string | null): Promise<QueueItem | null> {
  const r = await systemDb().query(
    `UPDATE repeat_task_queue SET status = 'removed', removed_reason = $2, removed_by = $3, removed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'queued' RETURNING *`, [id, reason, by],
  );
  const row = r.rows[0] ? rowToItem(r.rows[0]) : null;
  if (row) await logQueue('queue_removed', row, { payload: { reason, by } });
  return row;
}

/** Ручная постановка «Сразу» по заказчику из очереди — позиция снимается (причина manual). */
export async function removeByClient(clientKey: string, reason: string, by: string | null): Promise<void> {
  const { memberKeysOf } = await import('@/features/customers/engine/merge');
  const r = await systemDb().query(`SELECT id FROM repeat_task_queue WHERE client_key = ANY($1::text[]) AND status = 'queued'`, [await memberKeysOf(clientKey)]);
  for (const x of r.rows) await removeFromQueue(Number(x.id), reason, by);
}

export async function setBoost(id: number, boost: number): Promise<void> {
  await systemDb().query(`UPDATE repeat_task_queue SET boost = $2, updated_at = now() WHERE id = $1 AND status = 'queued'`,
    [id, Math.max(-2, Math.min(2, Math.round(boost)))]);
}

export async function fetchQueue(managerIds: string[] | null, opts: { includeDoneDays?: number } = {}): Promise<QueueItem[]> {
  const days = opts.includeDoneDays ?? 7;
  const r = await systemDb().query(
    `SELECT * FROM repeat_task_queue
      WHERE (status IN ('queued', 'issuing', 'failed') OR updated_at > now() - ($2 || ' days')::interval)
        ${managerIds ? 'AND manager_id = ANY($1::text[])' : 'AND $1::text[] IS NULL'}
      ORDER BY status, score DESC NULLS LAST, created_at`, [managerIds, String(days)],
  );
  return r.rows.map(rowToItem);
}

// ── Порядок ───────────────────────────────────────────────────────────────────

/** Score позиции (гипотеза Fable 22.10, калибровать по «Результат: задача → отгрузка»). */
export function queueScore(c: KanbanCard | null, boost: number): number {
  if (!c) return -100;
  const left = c.freshDays !== null ? WINDOW_DAYS - c.freshDays : null;
  const fWindow = left === null ? 0 : left <= 2 ? 1 : left <= 5 ? 0.7 : left <= 10 ? 0.4 : 0.25;
  const pot = c.potential && c.potential > 0 ? Math.min(1, Math.log10(c.potential) / 7) : 0; // 10 млн ₽ ≈ 1
  const out = c.lastOutcome === 'won' ? 1 : 0.3;
  const ret = c.returned ? 1 : 0;
  const type = c.profileType === 'foreman' || c.profileType === 'construction_org' ? 1 : c.profileType ? 0.6 : 0.4;
  return Math.round((3 * fWindow + 2 * pot + 1 * out + 2.5 * ret + 1 * type + 1.5 * boost) * 1000) / 1000;
}

/** Срок задачи по правилу позиции — в момент выдачи (как в окне задачи: «до конца окна» = отгрузка +
 *  22 дня, если до этого ≥ 2 дней; иначе новое окно от сегодня). */
export function deadlineFor(rule: DeadlineRule, card: KanbanCard | null, now = Date.now()): string {
  const ymd = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);
  if (rule === 'today') return ymd(now);
  if (rule === '3' || rule === '7') return ymd(now + Number(rule) * 86_400_000);
  if (card?.lastDeliveredAt) {
    const end = new Date(card.lastDeliveredAt).getTime() + WINDOW_DAYS * 86_400_000;
    if (end >= now + 2 * 86_400_000) return ymd(end);
  }
  return ymd(now + WINDOW_DAYS * 86_400_000);
}

// ── Выдача ────────────────────────────────────────────────────────────────────

async function boardCardsOf(managerId: string, managerName: string): Promise<Map<string, KanbanCard>> {
  const big = Object.fromEntries(['pool_hot', 'pool_1', 'pool_2_4', 'pool_5', 'touch_0', 'touch_1', 'touch_2', 'touch_3',
    'st_called', 'st_supply', 'st_offer', 'st_cheaper', 'st_reserved', 'st_sold', 'review', 'brak', 'hidden'].map(k => [k, 5000]));
  const b = await buildRepeatBoard({ managers: [{ id: managerId, name: managerName }], selectedManagers: [], typeFilter: null, canManage: false, skipNames: true, limits: big });
  // Позиция могла встать на исходный ключ до склейки заказчиков (merge.ts) — ищем и по членам.
  return new Map(b.columns.flatMap(c => c.cards).flatMap(c => [[c.clientKey, c] as const, ...c.members.map(m => [m.key, c] as const)]));
}

/** Почему позицию надо снять (по свежей карточке доски), или null — можно выдавать. */
function removalReason(c: KanbanCard | undefined): string | null {
  if (!c) return 'not_manager_client';
  if (c.column === 'brak') return 'brak';
  if (c.column === 'hidden') return 'hidden';
  if (!c.column.startsWith('pool')) return 'open_deal';
  return null;
}

export interface IssueResult { id: number; ok: boolean; taskId?: number; dealId?: number; error?: string; removed?: string }

/** Выдать одну позицию (джоб или «выдать сейчас»). card — свежая карточка (для срока и проверок). */
export async function issueItem(item: QueueItem, card: KanbanCard | null, opts: { creatorOverride?: string | null } = {}): Promise<IssueResult> {
  const db = systemDb();
  const lock = await db.query(
    `UPDATE repeat_task_queue SET status = 'issuing', issuing_started_at = now(), issue_attempts = issue_attempts + 1, updated_at = now()
      WHERE id = $1 AND status = 'queued' RETURNING id`, [item.id],
  );
  if (!lock.rowCount) return { id: item.id, ok: false, error: 'уже выдаётся или снята' };
  // Склейка заказчиков: позиция на исходном ключе выдаётся на каноничный (карточка доски).
  const ck = card?.clientKey ?? item.clientKey;
  try {
    const tpl = await getTemplate(item.templateId);
    const body = tpl ? (await renderTemplate(tpl.body, { clientKey: ck, managerId: item.managerId }).catch(() => '')).trim() : '';
    const comment = [body, item.comment?.trim()].filter(Boolean).join('\n\n');
    const res = await createRepeatTask({
      clientKey: ck, fallbackManagerId: item.managerId,
      creatorBitrixId: opts.creatorOverride ?? item.queuedBy, comment, commentAuthorId: opts.creatorOverride ?? item.queuedBy,
      deadlineDate: deadlineFor(item.deadlineRule, card), deadlineTime: item.deadlineTime,
      newResponsibleId: item.newResponsibleId,
      participants: item.participants,
    });
    rememberDealClient(res.dealId, ck);
    await db.query(
      `UPDATE repeat_task_queue SET status = 'issued', issued_task_id = $2, issued_deal_id = $3, issued_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1`, [item.id, res.taskId, res.dealId],
    );
    await logQueue(res.dealMode === 'created' ? 'deal_task_created' : res.dealMode === 'reopened' ? 'deal_returned_from_reject' : 'task_created',
      item, { dealId: res.dealId, taskId: res.taskId, payload: { comment, queueId: item.id, responsible: res.responsibleId } });
    return { id: item.id, ok: true, taskId: res.taskId, dealId: res.dealId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Бизнес-отказ Битрикса («Продано», «НЕ ТРОГАТЬ»…) — позиция снимается с причиной; сбой сети —
    // назад в очередь (до 3 попыток), потом failed.
    if (e instanceof DealCreateError && !/HTTP 5|timeout|fetch failed|ECONN/i.test(msg)) {
      await db.query(`UPDATE repeat_task_queue SET status = 'removed', removed_reason = 'bitrix_refused', last_error = $2, removed_at = now(), updated_at = now() WHERE id = $1`, [item.id, msg.slice(0, 500)]);
      await logQueue('queue_removed', item, { payload: { reason: 'bitrix_refused', error: msg } });
      return { id: item.id, ok: false, removed: 'bitrix_refused', error: msg };
    }
    await db.query(
      `UPDATE repeat_task_queue SET status = CASE WHEN issue_attempts >= 3 THEN 'failed' ELSE 'queued' END, last_error = $2, updated_at = now() WHERE id = $1`,
      [item.id, msg.slice(0, 500)],
    );
    return { id: item.id, ok: false, error: msg };
  }
}

const mskNow = (ms = Date.now()) => new Date(ms + 3 * 3600_000);
export function inWorkHours(ms = Date.now()): boolean {
  const d = mskNow(ms);
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day >= 1 && day <= 5 && h >= 9 && h < 18;
}

export interface IssueRunResult { managers: number; issued: number; removed: number; failed: number; skipped: string | null }

/** Один прогон джоба. Без рабочего времени ничего не делает (кроме зависших). */
export async function runQueueIssue(opts: { force?: boolean } = {}): Promise<IssueRunResult> {
  const db = systemDb();
  // Зависшие в issuing дольше 15 минут (процесс упал посреди Битрикса) — не повторяем, РОПу видно.
  await db.query(
    `UPDATE repeat_task_queue SET status = 'failed', last_error = 'Выдача оборвалась — проверьте в Битриксе, создана ли задача', updated_at = now()
      WHERE status = 'issuing' AND issuing_started_at < now() - interval '15 minutes'`,
  ).catch(() => {});
  if (!opts.force && !inWorkHours()) return { managers: 0, issued: 0, removed: 0, failed: 0, skipped: 'нерабочее время' };

  const settings = await fetchKanbanSettings();
  const queued = (await db.query(`SELECT * FROM repeat_task_queue WHERE status = 'queued'`)).rows.map(rowToItem);
  if (!queued.length) return { managers: 0, issued: 0, removed: 0, failed: 0, skipped: 'очередь пуста' };
  const byMgr = new Map<string, QueueItem[]>();
  for (const q of queued) byMgr.set(q.managerId, [...(byMgr.get(q.managerId) ?? []), q]);
  const mgrIds = [...byMgr.keys()];
  const [load, today, names] = await Promise.all([
    fetchManagerLoad(mgrIds),
    db.query<{ m: string; n: string }>(
      `SELECT manager_id AS m, count(*)::text AS n FROM repeat_task_queue
        WHERE status = 'issued' AND issued_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'
          AND manager_id = ANY($1::text[]) GROUP BY 1`, [mgrIds],
    ).then(r => new Map(r.rows.map(x => [x.m, Number(x.n)]))),
    managerDirectory(mgrIds),
  ]);

  let issued = 0, removed = 0, failed = 0;
  const RUN_CAP = 5;
  for (const [mid, items] of byMgr) {
    const info = names.get(mid);
    if (!info?.active) continue; // уволен/неактивен — очередь заморожена (видно РОПу)
    const slots = Math.min(settings.managerTaskLimit - (load[mid] ?? 0), settings.queueDailyLimit - (today.get(mid) ?? 0));
    // Снятие ненужных позиций делаем и без свободных слотов: держим очередь чистой.
    const cards = await boardCardsOf(mid, info.name).catch(e => { console.warn('[repeat-queue] доска менеджера', mid, e instanceof Error ? e.message : e); return null; });
    if (!cards) continue;
    const alive: { item: QueueItem; card: KanbanCard; score: number }[] = [];
    for (const it of items) {
      const c = cards.get(it.clientKey);
      const why = removalReason(c);
      if (why) { if (await removeFromQueue(it.id, why, null)) removed++; continue; }
      const score = queueScore(c!, it.boost);
      alive.push({ item: it, card: c!, score });
      await db.query(`UPDATE repeat_task_queue SET score = $2, score_at = now() WHERE id = $1`, [it.id, score]).catch(() => {});
    }
    if (slots <= 0 || issued >= RUN_CAP || !alive.length) continue;
    alive.sort((a, b) => b.score - a.score || a.item.createdAt.localeCompare(b.item.createdAt));
    const top = alive[0];
    const r = await issueItem(top.item, top.card);
    if (r.ok) issued++; else if (r.removed) removed++; else failed++;
  }
  return { managers: byMgr.size, issued, removed, failed, skipped: null };
}

export async function fetchQueueItem(id: number): Promise<QueueItem | null> {
  const r = await systemDb().query(`SELECT * FROM repeat_task_queue WHERE id = $1`, [id]);
  return r.rows[0] ? rowToItem(r.rows[0]) : null;
}

/** «Выдать сейчас» (РОП из вкладки «Очередь»): без нормы и дневного лимита, постановщик — нажавший. */
export async function issueNow(id: number, creator: string | null): Promise<IssueResult> {
  const item = await fetchQueueItem(id);
  if (!item || item.status !== 'queued') return { id, ok: false, error: 'Позиция уже выдана или снята' };
  const info = (await managerDirectory([item.managerId])).get(item.managerId);
  const cards = await boardCardsOf(item.managerId, info?.name ?? item.managerId);
  const card = cards.get(item.clientKey);
  const why = removalReason(card);
  if (why) { await removeFromQueue(id, why, creator); return { id, ok: false, removed: why, error: REMOVED_LABEL[why] ?? why }; }
  return issueItem(item, card ?? null, { creatorOverride: creator });
}

export const REMOVED_LABEL: Record<string, string> = {
  manual: 'снята РОПом', not_manager_client: 'заказчик уже не у этого менеджера', brak: 'заказчик в браке',
  hidden: 'заказчик скрыт', open_deal: 'уже есть открытая сделка', bitrix_refused: 'Битрикс отказал',
};

/** Имена и активность менеджеров (оргструктура sa). */
export async function managerDirectory(ids: string[]): Promise<Map<string, { name: string; active: boolean }>> {
  if (!ids.length) return new Map();
  const { analyticsDb } = await import('@/lib/db/clients');
  const r = await analyticsDb().query<{ id: string; name: string; active: boolean }>(
    `SELECT DISTINCT ON (manager_bitrix_user_id) manager_bitrix_user_id::text AS id, manager_name AS name, is_active AS active
       FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::text = ANY($1::text[])
      ORDER BY manager_bitrix_user_id, is_active DESC`, [ids],
  ).catch(() => ({ rows: [] as { id: string; name: string; active: boolean }[] }));
  return new Map(r.rows.map(x => [x.id, { name: x.name, active: x.active }]));
}
