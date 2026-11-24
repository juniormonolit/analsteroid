// Задачи по СДЕЛКЕ (миграция 289, TASKER_SPEC.md «Задачи по сделкам»).
// Директор/РОП в дриллдауне отчёта видит «висящую» сделку и ставит по ней задачу:
//   исполнитель (RESPONSIBLE_ID) — менеджер сделки (sa.deals.current_manager_id; у проданных сделок там заморожен
//   продавец — триггер 266, это и нужно: спрашиваем с того, кто вёл сделку), соисполнитель — его РОП,
//   наблюдатели — постановщик и директор (и нажавший, если ставит не от себя); UF_CRM_TASK = D_<id> — задача видна
//   в карточке сделки Битрикса. Снимок сделки — в задаче (deal_snapshot).
// Лимит «≤ 3 открытых» не действует; дубль — вторая открытая задача по той же сделке.
// К сроку — автопроверка (checkDealsDue, фоновая задача tasker): продана / проиграна / сдвинулась / без движения.
import { randomUUID } from 'node:crypto';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { canSeeManager, type SessionScope } from '@/lib/org/sessionScope';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import { resolveClientNames } from '@/lib/bitrix/clientNames';
import { ropOfManager } from '@/features/repeat-kanban/engine/createDeal';
import {
  TASKER_DEAL_TOPIC_ID, TASKER_VERDICT_LABELS,
  type Snapshot, type TaskerCreateResponse, type TaskerDealCreateRequest, type TaskerDealPreviewResponse,
  type TaskerDealSnapshot, type TaskerTask, type TaskerVerdict, type TaskerWarning,
} from '../types';
import {
  appBaseUrl, bxDate, directorFor, loadMetricDefs, loadSettings, mskToday, NOT_CONFIGURED_MESSAGE, portalBaseUrl,
  TaskerError, toMskIso,
} from './config';
import { creatorOptions } from './creators';
import { drainTask, enqueue, type BxOp } from './bitrix';
import { getTask, OPEN_TASK_SQL, TASK_COLUMNS, viewerOf, type TaskRow } from './repo';
import { invalidateLive } from './live';

const MAX_DEALS = 30;
const MAX_CHECK_ATTEMPTS = 6;
const DAY_MS = 86_400_000;

export const dealUrl = (id: number) => `${portalBaseUrl()}/crm/deal/details/${id}/`;

const EMPTY_SNAPSHOT: Snapshot = { value: null, deptAvg: null, ownAvg6m: null, deptName: null, enoughData: false };

// ── Снимок сделки ───────────────────────────────────────────────────────────

interface DealRow {
  deal_id: string; deal_name: string | null; amount: string | null; stage_id: string | null; stage_name: string | null;
  stage_type: string | null; funnel_name: string | null; manager_id: string | null; updated_at: Date | null;
  sold_at: Date | null; lost_at: Date | null; contact_id: string | null; company_id: string | null; stage_since: Date | null;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Снимки сделок «как сейчас» из sa.deals. «В стадии с» — последний переход в текущую стадию по sa.deal_events
 *  (история ведётся с 03.04.2026); нет истории — дата изменения сделки (updated_at, менее точно — помечаем). */
export async function loadDealSnapshots(ids: number[]): Promise<Map<number, TaskerDealSnapshot>> {
  const out = new Map<number, TaskerDealSnapshot>();
  if (!ids.length) return out;
  const r = await analyticsDb().query<DealRow>(
    `SELECT d.deal_id, d.deal_name, d.amount, d.stage_id::text AS stage_id, s.name AS stage_name, s.event_type AS stage_type,
            f.name AS funnel_name, d.current_manager_id::text AS manager_id, d.updated_at, d.sold_at, d.lost_at,
            d.contact_id::text AS contact_id, d.company_id::text AS company_id,
            (SELECT max(e.event_at) FROM sa.deal_events e WHERE e.deal_id = d.deal_id AND e.stage_id = d.stage_id) AS stage_since
       FROM sa.deals d
       LEFT JOIN sa.stages s  ON s.id = d.stage_id
       LEFT JOIN sa.funnels f ON f.id = d.funnel_id
      WHERE d.deal_id = ANY($1::bigint[])`,
    [ids],
  );
  // Клиент: имя компании, иначе контакта — из того же кэша имён Битрикса, что у карточки заказчика (lib/bitrix/clientNames).
  // Не через CLIENT_KEY_CASE_SQL: у юр-сделок с company_id IS NULL и у B2C без контакта ключ там NULL — поле было пустым
  // (сделка 280340, прод 24.11). Пробуем k<company>, затем c<contact> (контакт Битрикса; x-ключи заказчиков в кэш не плодим).
  const keysOf = (x: DealRow) => [
    ...(x.company_id && x.company_id !== '0' ? [`k${x.company_id}`] : []),
    ...(x.contact_id && x.contact_id !== '0' ? [`c${x.contact_id}`] : []),
  ];
  const keys = [...new Set(r.rows.flatMap(keysOf))];
  const [names, dir] = await Promise.all([
    resolveClientNames(keys).catch(e => { console.warn('[tasker] имена клиентов:', e instanceof Error ? e.message : e); return new Map<string, string | null>(); }),
    getEmployeeDirectory(),
  ]);
  const now = Date.now();
  for (const x of r.rows) {
    const id = Number(x.deal_id);
    const since = x.stage_since ?? x.updated_at;
    const mgr = x.manager_id && x.manager_id !== '0' ? Number(x.manager_id) : null;
    out.set(id, {
      dealId: id,
      title: x.deal_name,
      // Имени нет (Битрикс не ответил / пусто) — номер, как в карточке сделки дриллдауна.
      client: keysOf(x).map(k => names.get(k)).find(n => !!n?.trim())
        ?? (x.company_id && x.company_id !== '0' ? `компания #${x.company_id}` : x.contact_id && x.contact_id !== '0' ? `контакт #${x.contact_id}` : null),
      amount: x.amount === null ? null : Number(x.amount),
      funnel: x.funnel_name,
      stageId: x.stage_id,
      stage: x.stage_name ?? x.stage_id,
      stageType: x.stage_type,
      stageSince: iso(since),
      stageSinceSource: x.stage_since ? 'history' : x.updated_at ? 'updated' : null,
      daysInStage: since ? Math.max(0, Math.floor((now - new Date(since).getTime()) / DAY_MS)) : null,
      soldAt: iso(x.sold_at),
      lostAt: iso(x.lost_at),
      managerId: mgr,
      managerName: mgr ? dir.get(mgr)?.name ?? `#${mgr}` : null,
      url: dealUrl(id),
      at: new Date(now).toISOString(),
    });
  }
  return out;
}

/** Открытые задачи по сделкам: deal_id → id задачи. */
async function openDealTasks(ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const r = await systemDb().query<{ deal_id: string; id: string }>(
    `SELECT DISTINCT ON (t.deal_id) t.deal_id, t.id FROM tasker_tasks t
      WHERE t.kind = 'deal' AND t.deal_id = ANY($1::bigint[]) AND ${OPEN_TASK_SQL} ORDER BY t.deal_id, t.id DESC`, [ids]);
  return new Map(r.rows.map(x => [Number(x.deal_id), Number(x.id)]));
}

function parseIds(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0))];
}

/** GET /api/tasker/deal-tasks?dealIds — снимки для формы + в зоне ли менеджер + уже открытая задача. */
export async function previewDeals(scope: SessionScope, rawIds: unknown): Promise<TaskerDealPreviewResponse> {
  const ids = parseIds(rawIds).slice(0, MAX_DEALS);
  if (!ids.length) throw new TaskerError('Не выбрана ни одна сделка');
  const [snaps, open] = await Promise.all([loadDealSnapshots(ids), openDealTasks(ids)]);
  return {
    deals: ids.filter(id => snaps.has(id)).map(id => {
      const s = snaps.get(id)!;
      return { ...s, allowed: !!s.managerId && canSeeManager(scope, String(s.managerId)), openTaskId: open.get(id) ?? null };
    }),
    missing: ids.filter(id => !snaps.has(id)),
  };
}

// ── Создание ────────────────────────────────────────────────────────────────

export function validateDealCreate(body: unknown): TaskerDealCreateRequest {
  const b = (body ?? {}) as Partial<TaskerDealCreateRequest>;
  const dealIds = parseIds(b.dealIds);
  if (!dealIds.length) throw new TaskerError('Не выбрана ни одна сделка');
  if (dealIds.length > MAX_DEALS) throw new TaskerError(`Не больше ${MAX_DEALS} сделок за раз`);
  if (typeof b.deadline !== 'string' || !b.deadline) throw new TaskerError('Не задан срок');
  const body2 = typeof b.body === 'string' ? b.body.slice(0, 20_000) : '';
  if (!body2.trim()) throw new TaskerError('Напишите, что сделать по сделке (или выберите шаблон)');
  return {
    dealIds, body: body2, deadline: b.deadline,
    templateId: b.templateId ? Number(b.templateId) : null,
    creatorBitrixId: Number.isInteger(Number(b.creatorBitrixId)) && Number(b.creatorBitrixId) > 0 ? Number(b.creatorBitrixId) : null,
  };
}

const money = (v: number | null) => (v === null ? '—' : `${Math.round(v).toLocaleString('ru-RU')} ₽`);
const dmy = (s: string | null) => (s ? new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—');

export function stageLine(s: TaskerDealSnapshot): string {
  const days = s.daysInStage === null ? '' : ` — ${s.daysInStage} дн.${s.stageSince ? ` (с ${dmy(s.stageSince)}${s.stageSinceSource === 'updated' ? ', по дате изменения сделки' : ''})` : ''}`;
  return `${s.funnel ? `${s.funnel} · ` : ''}${s.stage ?? '—'}${days}`;
}

function describe(s: TaskerDealSnapshot, input: { body: string; managerName: string; deadlineIso: string; taskId: number; marker: string }): string {
  return [
    `[B]Сделка:[/B] [URL=${s.url}]${s.title || `#${s.dealId}`}[/URL] (#${s.dealId})`,
    `[B]Менеджер:[/B] ${input.managerName}`,
    `[B]Клиент:[/B] ${s.client ?? '—'}`,
    `[B]Сумма:[/B] ${money(s.amount)}`,
    `[B]Стадия:[/B] ${stageLine(s)}`,
    '',
    '[B]Что сделать:[/B]',
    input.body.trim(),
    '',
    `[COLOR=#999999]К сроку (${dmy(input.deadlineIso)}) Задачник сам проверит сделку: сменила стадию, продана, проиграна или без движения — итог придёт комментарием.[/COLOR]`,
    `[url=${appBaseUrl()}/tasker?task=${input.taskId}]Открыть в Монолитике[/url]`,
    `[COLOR=#999999]Задачник Монолитики · ${input.marker}[/COLOR]`,
  ].join('\n');
}

export async function createDealTasks(session: SessionUser, scope: SessionScope, raw: unknown): Promise<TaskerCreateResponse> {
  const req = validateDealCreate(raw);
  const settings = await loadSettings();
  if (!settings.groupId) throw new TaskerError(NOT_CONFIGURED_MESSAGE, 'not_configured', 409);
  const topic = (await loadMetricDefs()).find(m => m.id === TASKER_DEAL_TOPIC_ID);
  if (!topic) throw new TaskerError('Задачи по сделкам ещё не включены: не накачена миграция 289', 'not_configured', 409);

  const warnings: TaskerWarning[] = [];
  const [snaps, open, dir] = await Promise.all([loadDealSnapshots(req.dealIds), openDealTasks(req.dealIds), getEmployeeDirectory()]);
  const nameOf = (id: string | null) => (id ? dir.get(Number(id))?.name ?? null : null);

  const eligible: TaskerDealSnapshot[] = [];
  for (const id of req.dealIds) {
    const s = snaps.get(id);
    if (!s) { warnings.push({ managerId: null, code: 'deal_not_found', message: `Сделка #${id} не найдена — задача не поставлена` }); continue; }
    if (!s.managerId) { warnings.push({ managerId: null, code: 'deal_not_found', message: `Сделка #${id}: у сделки нет менеджера — некому ставить задачу` }); continue; }
    if (!canSeeManager(scope, String(s.managerId))) {
      warnings.push({ managerId: s.managerId, code: 'forbidden_manager', message: `Сделка #${id}: менеджер ${s.managerName ?? ''} не в вашей зоне — задача не поставлена` });
      continue;
    }
    if (open.has(id)) {
      warnings.push({ managerId: s.managerId, code: 'duplicate_deal', message: `Сделка #${id}: по ней уже есть открытая задача — вторую не ставим` });
      continue;
    }
    eligible.push(s);
  }
  if (!eligible.length) return { created: [], warnings };

  // Постановщик — как в обычной форме: сам нажавший или выбранный из /api/tasker/creators.
  const clickerBx = session.bitrixUserId ? String(session.bitrixUserId) : null;
  let creatorBx = clickerBx;
  let creatorName = session.displayName;
  if (req.creatorBitrixId && String(req.creatorBitrixId) !== clickerBx) {
    const { creators } = await creatorOptions(session, scope, settings, [...new Set(eligible.map(s => String(s.managerId)))]);
    const pick = creators.find(c => c.id === req.creatorBitrixId);
    if (!pick) throw new TaskerError('Этого постановщика выбрать нельзя — доступны вы, ваш директор и (для директора) РОПы', 'forbidden', 403);
    creatorBx = String(pick.id);
    creatorName = pick.name;
  }
  const onBehalf = creatorBx !== clickerBx;

  const deadlineIso = toMskIso(req.deadline);
  const controlDate = new Date(deadlineIso).toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(0, 10);
  const today = mskToday();
  const createdIds: number[] = [];

  for (const s of eligible) {
    const managerId = String(s.managerId);
    const entry = dir.get(Number(managerId));
    const managerName = entry?.name ?? s.managerName ?? `#${managerId}`;
    const rop = await ropOfManager(managerId).catch(() => null);
    const director = directorFor(settings, entry?.branch);
    const accomplices = rop && rop !== managerId ? [rop] : [];
    const auditorSet = new Set<string>();
    const skip = new Set([managerId, ...accomplices]);
    for (const a of [creatorBx, director, onBehalf ? clickerBx : null]) if (a && !skip.has(a)) auditorSet.add(a);
    const auditors = [...auditorSet];

    const marker = `TSK-${randomUUID().slice(0, 8)}`;
    const days = s.daysInStage === null ? '' : `, ${s.daysInStage} дн.`;
    const title = `Сделка #${s.dealId} «${(s.title ?? '').slice(0, 80)}»: ${s.stage ?? 'стадия ?'}${days} — ${managerName}`.slice(0, 250);
    const ins = await systemDb().query<{ id: string }>(
      `INSERT INTO tasker_tasks (marker, manager_bitrix_id, manager_name, rop_bitrix_id, rop_name, director_bitrix_id, director_name,
          creator_bitrix_id, creator_user_id, creator_name, dept_name, metric_id, period_from, period_to, snapshot, target, template_id,
          title, body, deadline, duration_min, control_date, kind, executor_bitrix_id, executor_name, auditor_ids, deal_id, deal_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14::jsonb,NULL,$15,$16,$17,$18,30,$19,'deal',$2,$3,$20::text[],$21,$22::jsonb)
       RETURNING id`,
      [marker, managerId, managerName, rop, nameOf(rop), director, nameOf(director),
        creatorBx, session.id, creatorName, entry?.departmentName ?? null, topic.id, today, JSON.stringify(EMPTY_SNAPSHOT),
        req.templateId, title, req.body, deadlineIso, controlDate, auditors, s.dealId, JSON.stringify(s)]);
    const taskId = Number(ins.rows[0].id);
    createdIds.push(taskId);

    const fields: Record<string, unknown> = {
      TITLE: title,
      DESCRIPTION: describe(s, { body: req.body, managerName, deadlineIso, taskId, marker }),
      RESPONSIBLE_ID: Number(managerId),
      ...(creatorBx ? { CREATED_BY: Number(creatorBx) } : {}),
      ...(accomplices.length ? { ACCOMPLICES: accomplices.map(Number) } : {}),
      ...(auditors.length ? { AUDITORS: auditors.map(Number) } : {}),
      TAGS: [topic.tag],
      DEADLINE: bxDate(deadlineIso),
      TASK_CONTROL: 'N',
      UF_CRM_TASK: [`D_${s.dealId}`],
    };
    const ops: BxOp[] = [{ op: 'create_task', fields, marker, creatorBitrixId: creatorBx }];
    await enqueue(taskId, ops);
    const res = await drainTask(taskId, { force: true }).catch(e => ({ done: 0, error: e instanceof Error ? e.message : String(e) }));
    if (res.error) {
      warnings.push({ managerId: s.managerId, code: 'bitrix_failed', message: `Сделка #${s.dealId}: задача сохранена в Монолитике, но Битрикс пока не принял (${res.error}) — повторим автоматически` });
    }
  }

  invalidateLive(settings.groupId);
  const viewer = viewerOf(session);
  const created = (await Promise.all(createdIds.map(id => getTask(id, viewer)))).filter((t): t is TaskerTask => !!t);
  return { created, warnings };
}

// ── Автопроверка к сроку ────────────────────────────────────────────────────

const isWon = (s: TaskerDealSnapshot) => s.stageType === 'sold' || s.stageType === 'shipped' || !!s.soldAt;
const isLost = (s: TaskerDealSnapshot) => s.stageType === 'lost';

/** Вердикт: стадия сменилась (или сделка заново вошла в ту же стадию) → проиграна / продана / сдвинулась;
 *  иначе — без движения. «Продана» — только если при постановке ещё не была продана (отгрузка проданной = «сдвинулась»). */
export function dealVerdictOf(before: TaskerDealSnapshot, after: TaskerDealSnapshot): TaskerVerdict {
  const reentered = before.stageSinceSource === 'history' && after.stageSinceSource === 'history'
    && !!before.stageSince && !!after.stageSince && after.stageSince > before.stageSince;
  if (after.stageId === before.stageId && !reentered) return 'deal_stuck';
  if (isLost(after)) return 'deal_lost';
  if (isWon(after) && !isWon(before)) return 'deal_won';
  return 'deal_moved';
}

function checkComment(before: TaskerDealSnapshot, after: TaskerDealSnapshot, verdict: TaskerVerdict): string {
  return [
    `[B]Автопроверка Задачника: ${TASKER_VERDICT_LABELS[verdict]}[/B]`,
    `Было при постановке: ${stageLine(before)}.`,
    `Сейчас: ${stageLine(after)}. Сумма: ${money(after.amount)}.`,
  ].join('\n');
}

type DealTaskRow = TaskRow & { deal_id: string | null; deal_snapshot: TaskerDealSnapshot | null; measure_attempts: number };

/** Тик фоновой задачи: задачи по сделкам, у которых наступил срок, без вердикта. */
export async function checkDealsDue(limit = 50): Promise<{ measured: number; failed: number }> {
  const r = await systemDb().query<DealTaskRow>(
    `SELECT ${TASK_COLUMNS} FROM tasker_tasks t
      WHERE t.kind = 'deal' AND t.verdict IS NULL AND t.cancelled_at IS NULL AND t.deadline <= now()
        AND t.measure_attempts < $1 AND (t.measured_at IS NULL OR t.measured_at < now() - interval '1 hour')
      ORDER BY t.deadline, t.id LIMIT $2`,
    [MAX_CHECK_ATTEMPTS, limit]).catch(e => {
    if ((e as { code?: string }).code === '22P02' || (e as { code?: string }).code === '42703') return { rows: [] as DealTaskRow[] };
    throw e;
  });
  if (!r.rows.length) return { measured: 0, failed: 0 };
  let measured = 0, failed = 0;
  const fail = async (row: DealTaskRow, msg: string) => {
    failed++;
    await systemDb().query(
      `UPDATE tasker_tasks SET measure_attempts = measure_attempts + 1, measure_error = $2, measured_at = now() WHERE id = $1`,
      [row.id, msg.slice(0, 500)]);
  };
  let snaps: Map<number, TaskerDealSnapshot>;
  try {
    snaps = await loadDealSnapshots(r.rows.map(x => Number(x.deal_id)).filter(Boolean));
  } catch (e) {
    for (const row of r.rows) await fail(row, e instanceof Error ? e.message : String(e));
    return { measured, failed };
  }
  for (const row of r.rows) {
    try {
      const before = row.deal_snapshot;
      const after = snaps.get(Number(row.deal_id));
      if (!before || !after) { await fail(row, after ? 'нет снимка сделки при постановке' : 'сделка не найдена в sa.deals'); continue; }
      const verdict = dealVerdictOf(before, after);
      const upd = await systemDb().query(
        `UPDATE tasker_tasks SET verdict = $2, measured_snapshot = $3::jsonb, measured_at = now(), measure_error = NULL, updated_at = now()
          WHERE id = $1 AND verdict IS NULL`,
        [row.id, verdict, JSON.stringify(after)]);
      if (!upd.rowCount) continue;
      measured++;
      if (row.bitrix_task_id) {
        await enqueue(Number(row.id), [{ op: 'comment', text: checkComment(before, after, verdict) }]);
        await drainTask(Number(row.id)).catch(() => {});
      }
    } catch (e) {
      await fail(row, e instanceof Error ? e.message : String(e));
    }
  }
  return { measured, failed };
}
