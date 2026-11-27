// Создание задач Задачника (TASKER_SPEC.md, «Сценарий» п.3, «Анти-спам», «Темы»).
// Один запрос — несколько менеджеров: у каждого свой снимок, своя задача в Битриксе (одна задача = один менеджер).
// Правка 23.11 (TASKER_FEEDBACK_2026-11-23.md п.1): исполнитель — НЕ менеджер, а РОП/постановщик («Практика —
// работаю сам») или тренер из tasker_settings.trainer («Теория»). Менеджер — в описании и участник события
// календаря, наблюдателем не ставим; директор (и РОП менеджера, если он не исполнитель/постановщик) — наблюдатели.
// TASK_CONTROL='N' — «Ждёт контроля» нет, исполнитель завершает сам с «Что сделано» (patch.ts).
import { randomUUID } from 'node:crypto';
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { canSeeManager, type SessionScope } from '@/lib/org/sessionScope';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import { ropOfManager } from '@/features/repeat-kanban/engine/createDeal';
import { TASKER_KIND_LABELS, type Snapshot, type TaskerCreateRequest, type TaskerCreateResponse, type TaskerTask, type TaskerTaskKind, type TaskerWarning } from '../types';
import {
  addDaysYmd, appBaseUrl, bxDate, DEFAULT_CONTROL_DAYS, directorFor, fmtValue, isYmd, loadSettings, MAX_OPEN_TASKS,
  MIN_DENOMINATOR, NOT_CONFIGURED_MESSAGE, SESSION_BASE_MIN, SESSION_PER_EXTRA_MIN, TaskerError, toMskIso,
  type TaskerMetricDef, type TaskerSettings,
} from './config';
import { computeSnapshots, snapshotCacheScope, stripMeta } from './snapshot';
import { resolveTopic } from './topics';
import { inRequestRunner, type ReportRunner } from './reportRunner';
import { crmBindingOf, loadHotCustomers } from './customers';
import { drainTask, enqueue, type BxOp } from './bitrix';
import { getTask, OPEN_TASK_SQL, viewerOf } from './repo';
import { invalidateLive } from './live';
import { creatorOptions } from './creators';
import { defaultGoal, goalWorseThanCurrent } from '../goal';
import { autoPlaceTheory, placeTheoryEvent } from '../trainings/engine/autoTheory';
import { hardConflictMessage } from './availability';
import { notifyManagersNow } from './managerNotify';
import { fmtWhen, slotsOverlap } from './when';
import { closureMessage, findClosure } from '../trainings/engine/closures';
import { syncTaskEnrollments } from '../trainings/engine/taskLink';

/** Директор/админ может обойти лимит «≤ 3 открытых» (дубль метрики не обходится). */
export function canOverrideLimits(session: SessionUser, settings: TaskerSettings): boolean {
  return hasFullManagerAccess(session) || session.roleName === 'Директор'
    || (!!session.bitrixUserId && Object.values(settings.directors).includes(String(session.bitrixUserId)));
}

export function sessionDuration(managers: number): number {
  return SESSION_BASE_MIN + SESSION_PER_EXTRA_MIN * Math.max(0, managers - 1);
}

/** Не больше дат за одну постановку «Практики» (вт + чт + …). */
export const MAX_SLOTS_PER_REQUEST = 10;

const hasTime = (v: string) => /T\d{2}:\d{2}/.test(v);

export function validateCreate(body: unknown): TaskerCreateRequest {
  const b = (body ?? {}) as Partial<TaskerCreateRequest>;
  const ids = Array.isArray(b.managerIds) ? [...new Set(b.managerIds.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
  if (!ids.length) throw new TaskerError('Не выбран ни один менеджер');
  if (ids.length > 30) throw new TaskerError('Не больше 30 менеджеров за раз');
  if (!b.metricId || typeof b.metricId !== 'string') throw new TaskerError('Не выбран показатель');
  if (!b.period || !isYmd(b.period.from) || !isYmd(b.period.to) || b.period.from > b.period.to) throw new TaskerError('Некорректный период снимка');
  if (typeof b.deadline !== 'string' || !b.deadline) throw new TaskerError('Не задан срок');
  if (!isYmd(b.controlDate)) throw new TaskerError('Некорректная контрольная дата замера');
  const durationMin = Number(b.durationMin ?? 30);
  if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 8 * 60) throw new TaskerError('Длительность — от 5 минут до 8 часов');
  const kind: TaskerTaskKind = b.kind === 'theory' ? 'theory' : 'practice';
  const trainingEventId = b.trainingEventId ? Number(b.trainingEventId) : null;
  const sessionId = b.sessionId ? Number(b.sessionId) : null;
  const noTime = !!b.noTime;

  // Слоты: «Практика» может нести несколько дат (п.4 собрания 26.11); у «Теории» — одно своё время.
  const rawSlots = Array.isArray(b.slots) && b.slots.length ? b.slots : b.slot?.start ? [b.slot] : [];
  const starts = [...new Set(rawSlots.map(x => (x && typeof x.start === 'string' ? x.start : '')).filter(Boolean))];
  if (starts.length > MAX_SLOTS_PER_REQUEST) throw new TaskerError(`Не больше ${MAX_SLOTS_PER_REQUEST} дат за одну постановку`);
  if (kind === 'theory' && starts.length > 1) throw new TaskerError('У «Теории» одно время занятия');
  for (const st of starts) if (Number.isNaN(Date.parse(st))) throw new TaskerError(`Некорректное время: ${st}`);
  const slotsAll = starts.map(st => ({ start: st }));

  if (kind === 'practice' && !trainingEventId) {
    // п.5: время у «Практики» обязательно — без него нет ни проверки пересечений, ни «с 15:00 до 15:30» менеджеру.
    if (!noTime && !sessionId && !slotsAll.length) {
      throw new TaskerError('У «Практики» обязательны дата и время встречи. Нужна задача только со сроком — отметьте «Без времени, только срок»');
    }
    if (!noTime && slotsAll.some(x => !hasTime(x.start))) throw new TaskerError('Укажите время встречи, не только дату');
    if (sessionId && slotsAll.length > 1) throw new TaskerError('В существующую сессию — одна дата; несколько дат — новыми встречами');
    // Даты одной постановки не должны наслаиваться друг на друга.
    if (slotsOverlap(slotsAll.map(x => Date.parse(x.start)), durationMin)) throw new TaskerError('Две даты постановки накладываются друг на друга — разведите время');
  }
  if (b.newSession && !slotsAll.length) throw new TaskerError('Для новой сессии нужен слот (дата и время)');
  const target = b.target === null || b.target === undefined || (b.target as unknown) === '' ? null : Number(b.target);
  if (target !== null && !Number.isFinite(target)) throw new TaskerError('Цель должна быть числом');
  const posInt = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    managerIds: ids, metricId: b.metricId, period: { from: b.period.from, to: b.period.to }, target,
    body: typeof b.body === 'string' ? b.body.slice(0, 20_000) : '', templateId: b.templateId ? Number(b.templateId) : null,
    deadline: b.deadline, durationMin: Math.round(durationMin), slot: slotsAll[0] ?? null, slots: slotsAll,
    sessionId, newSession: !!b.newSession, controlDate: b.controlDate,
    customersChecklist: Array.isArray(b.customersChecklist) ? b.customersChecklist.filter((x): x is string => typeof x === 'string').slice(0, 200) : [],
    trainingEventId, overrideLimits: !!b.overrideLimits,
    creatorBitrixId: posInt(b.creatorBitrixId), executorBitrixId: posInt(b.executorBitrixId),
    kind, noTime: kind === 'practice' && noTime && !slotsAll.length,
  };
}

export { fmtWhen };

function periodLabel(p: { from: string; to: string }): string {
  const f = (s: string) => s.split('-').reverse().join('.');
  return `${f(p.from)} — ${f(p.to)}`;
}

function describe(input: {
  metric: TaskerMetricDef; snap: Snapshot; target: number | null; req: TaskerCreateRequest; managerName: string; taskId: number; marker: string;
  kind: TaskerTaskKind; assigneeName: string; managerId: string; plan: string | null; slot: { start: string; end: string } | null;
}): string {
  const { metric, snap, target, req } = input;
  const f = (v: number | null) => fmtValue(v, metric.format);
  const dir = metric.higherIsBetter ? 'больше — лучше' : 'меньше — лучше';
  const lines = [
    `[B]Менеджер:[/B] ${input.managerName}`,
    `[B]Формат:[/B] ${input.kind === 'theory' ? `Теория — ${input.assigneeName}` : `Практика — ${input.assigneeName} работает с менеджером`}`,
    ...(input.slot ? [`[B]Когда:[/B] ${fmtWhen(input.slot.start, input.slot.end)}`] : []),
    `[B]Цель:[/B] ${metric.label} — ${f(target)} (${dir}). Замер результата: ${req.controlDate.split('-').reverse().join('.')}.`,
    '',
    `[B]Снимок за ${periodLabel(req.period)}:[/B]`,
    `• ${input.managerName}: ${f(snap.value)}`,
    `• Среднее по отделу${snap.deptName ? ` (${snap.deptName})` : ''}: ${f(snap.deptAvg)}`,
    `• Своё среднее за 6 мес.: ${f(snap.ownAvg6m)}`,
  ];
  if (!snap.enoughData) {
    lines.push(`[COLOR=#999999]Мало данных: в знаменателе ${snap.denominator ?? 0} (< ${MIN_DENOMINATOR}) — вердикт замера может быть «мало данных».[/COLOR]`);
  }
  // План разбора для РОПа (п.6 собрания 26.11): шаблон темы из «Шаблоны → тема», с подстановкой периода.
  if (input.kind === 'practice' && input.plan?.trim()) {
    lines.push('', '[B]План разбора:[/B]', input.plan.trim()
      .replaceAll('{менеджер}', input.managerName).replaceAll('{период}', periodLabel(req.period)).replaceAll('{метрика}', metric.label));
    lines.push(`[url=${appBaseUrl()}/manager/${input.managerId}?tab=stats]Статистика менеджера в Монолитике[/url]`);
  }
  if (req.body.trim()) lines.push('', '[B]Рекомендации:[/B]', req.body.trim());
  if (req.trainingEventId) lines.push('', `[B]Обучение:[/B] [url=${appBaseUrl()}/tasker/trainings?event=${req.trainingEventId}]запись на обучение[/url]`);
  lines.push('', `[url=${appBaseUrl()}/tasker?task=${input.taskId}]Открыть в Монолитике[/url]`);
  lines.push(`[COLOR=#999999]Задачник Монолитики · ${input.marker}[/COLOR]`);
  return lines.join('\n');
}

interface Ctx {
  session: SessionUser; scope: SessionScope; settings: TaskerSettings; metric: TaskerMetricDef; req: TaskerCreateRequest;
}

/** Открытые задачи менеджеров: всего (лимит) и даты (МСК) открытых задач той же темы и того же типа — дубль.
 *  Дата задачи — день слота, а без слота — день срока. Теория и практика по одной теме — разные задачи.
 *  sameAny — есть ли вообще открытая той же темы и типа («Теория»: дубль без учёта даты, как раньше). */
async function openStats(managerIds: string[], metricId: string, kind: TaskerTaskKind): Promise<Map<string, { open: number; sameDays: Set<string>; sameAny: boolean }>> {
  const r = await systemDb().query<{ manager_bitrix_id: string; open: string; same_days: string[] | null }>(
    `SELECT t.manager_bitrix_id, count(*) AS open,
            array_agg(DISTINCT to_char(COALESCE(t.slot_start, t.deadline) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'))
              FILTER (WHERE t.metric_id = $2 AND COALESCE(t.kind, 'practice') = $3) AS same_days
       FROM tasker_tasks t WHERE t.manager_bitrix_id = ANY($1::text[]) AND ${OPEN_TASK_SQL}
        AND COALESCE(t.kind, 'practice') <> 'deal' -- задачи по сделке в лимит не входят (289)
      GROUP BY t.manager_bitrix_id`, [managerIds, metricId, kind]);
  return new Map(r.rows.map(x => [x.manager_bitrix_id, { open: Number(x.open), sameDays: new Set(x.same_days ?? []), sameAny: !!x.same_days?.length }]));
}

const mskDay = (iso: string) => new Date(Date.parse(iso) + 3 * 3600_000).toISOString().slice(0, 10);

async function practicePlan(metricId: string): Promise<string | null> {
  const r = await systemDb().query<{ practice_plan: string | null }>('SELECT practice_plan FROM tasker_metrics WHERE id = $1', [metricId])
    .catch(e => { if ((e as { code?: string })?.code === '42703') return { rows: [] as { practice_plan: string | null }[] }; throw e; });
  return r.rows[0]?.practice_plan ?? null;
}

/** Сессия для задачи: явная (проверяем исполнителя и тему), новая по слоту или без сессии. Ключ — исполнитель
 *  (РОП или тренер): сессия = одна встреча исполнителя с несколькими менеджерами (tasker_sessions.rop_bitrix_id). */
async function resolveSession(ctx: Ctx, assignee: string, slotStart: string | null, cache: Map<string, number>): Promise<{ id: number; slot: string } | null> {
  const { req } = ctx;
  if (req.sessionId) {
    const r = await systemDb().query<{ id: string; rop_bitrix_id: string; metric_id: string; slot_start: Date }>(
      `SELECT id, rop_bitrix_id, metric_id, slot_start FROM tasker_sessions WHERE id = $1`, [req.sessionId]);
    const s = r.rows[0];
    if (!s) throw new TaskerError('Сессия не найдена');
    if (s.metric_id !== ctx.metric.id) throw new TaskerError('Сессия по другой теме — выберите сессию по этому показателю');
    if (s.rop_bitrix_id !== assignee) throw new TaskerError('Сессию ведёт другой исполнитель — выберите свою сессию или новый слот');
    return { id: Number(s.id), slot: new Date(s.slot_start).toISOString() };
  }
  if (!req.newSession || !slotStart) return null;
  const slot = toMskIso(slotStart, '10:00:00');
  const key = `${assignee}|${slot}`;
  const have = cache.get(key);
  if (have) return { id: have, slot };
  const r = await systemDb().query<{ id: string }>(
    `INSERT INTO tasker_sessions (rop_bitrix_id, metric_id, slot_start, duration_min, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [assignee, ctx.metric.id, slot, SESSION_BASE_MIN, ctx.session.id]);
  const id = Number(r.rows[0].id);
  cache.set(key, id);
  return { id, slot };
}

async function refreshSessionDuration(sessionId: number): Promise<void> {
  await systemDb().query(
    `UPDATE tasker_sessions s SET duration_min = $2 + $3 * GREATEST(0, (SELECT count(DISTINCT manager_bitrix_id) FROM tasker_tasks t
        WHERE t.session_id = s.id AND t.cancelled_at IS NULL) - 1) WHERE s.id = $1`,
    [sessionId, SESSION_BASE_MIN, SESSION_PER_EXTRA_MIN]);
}

export async function createTasks(
  session: SessionUser, scope: SessionScope, body: unknown, run: ReportRunner = inRequestRunner,
): Promise<TaskerCreateResponse> {
  const req = validateCreate(body);
  const settings = await loadSettings();
  if (!settings.groupId) throw new TaskerError(NOT_CONFIGURED_MESSAGE, 'not_configured', 409);
  // Товарная группа, выбранная в форме без готовой темы (pg_<id>_amount), — тема заводится тут же (engine/topics.ts).
  const metric = await resolveTopic(req.metricId, { ensureBy: session.login });
  const ctx: Ctx = { session, scope, settings, metric, req };
  const warnings: TaskerWarning[] = [];

  // Доступ: только свои менеджеры (canSeeManager).
  const allowed: string[] = [];
  for (const id of req.managerIds) {
    if (canSeeManager(scope, String(id))) allowed.push(String(id));
    else warnings.push({ managerId: id, code: 'forbidden_manager', message: `Менеджер #${id} не в вашей зоне — задача не поставлена` });
  }
  if (!allowed.length) return { created: [], warnings };

  const kind: TaskerTaskKind = req.kind ?? 'practice';
  const dir = await getEmployeeDirectory();
  const nameOf = (id: string | null) => (id ? dir.get(Number(id))?.name ?? null : null);

  // Постановщик: выбранный в форме (тот же список, что отдаёт /api/tasker/creators) или сам нажавший.
  // В БД creator_bitrix_id/creator_name — постановщик, creator_user_id — кто фактически нажал (по нему
  // «мои поставленные», права правки и прогон автозамера). Не от себя → нажавший — наблюдатель в Битриксе.
  const clickerBx = session.bitrixUserId ? String(session.bitrixUserId) : null;
  let creatorBx = clickerBx;
  let creatorName = session.displayName;
  const needOptions = (req.creatorBitrixId && String(req.creatorBitrixId) !== clickerBx) || (kind === 'practice');
  const options = needOptions ? await creatorOptions(session, scope, settings, allowed) : null;
  if (req.creatorBitrixId && String(req.creatorBitrixId) !== clickerBx) {
    const pick = options!.creators.find(c => c.id === req.creatorBitrixId);
    if (!pick) throw new TaskerError('Этого постановщика выбрать нельзя — доступны вы, ваш директор и (для директора) РОПы', 'forbidden', 403);
    creatorBx = String(pick.id);
    creatorName = pick.name;
  }
  const onBehalf = creatorBx !== clickerBx;

  // Исполнитель (собрание 26.11, п.1): «Теория» — тренер; «Практика» — выбранный в поле «Исполнитель», а по
  // умолчанию РОП КАЖДОГО менеджера (не нашёлся — постановщик). Постановщик остаётся постановщиком.
  let fixedExecutor: string | null = null;
  if (kind === 'theory') fixedExecutor = settings.trainerId;
  else if (req.executorBitrixId) {
    const pick = (options?.executors ?? options?.creators ?? []).find(c => c.id === req.executorBitrixId);
    if (!pick) throw new TaskerError('Этого исполнителя выбрать нельзя — доступны РОП менеджера, вы, директор и (для директора) РОПы', 'forbidden', 403);
    fixedExecutor = String(pick.id);
  }
  const assigneeOf = (managerId: string): string | null => {
    if (fixedExecutor) return fixedExecutor;
    const rop = options?.ropByManager?.[managerId];
    return rop ? String(rop) : creatorBx;
  };
  for (const id of allowed) {
    if (!assigneeOf(id)) throw new TaskerError('Ваш аккаунт не связан с Битриксом — выберите постановщика или исполнителя');
  }
  const assigneeNameOf = (a: string) => nameOf(a) ?? (a === creatorBx ? creatorName : `#${a}`);

  // Даты «Практики» (п.4): по задаче на каждую дату; без времени — одна задача «до срока».
  const deadlineIso = toMskIso(req.deadline);
  const practiceSlots: (string | null)[] = kind === 'practice' && !req.trainingEventId && !req.sessionId && req.slots?.length
    ? req.slots.map(x => toMskIso(x.start, '10:00:00')) : [null];
  const dayOf = (slotIso: string | null) => mskDay(slotIso ?? deadlineIso);

  // Анти-спам: дубль — открытая задача той же темы и типа на ТУ ЖЕ дату («Практика» на вт и чт — можно);
  // у «Теории» по-прежнему любая открытая той же темы. Лимит открытых — по штукам, включая создаваемые сейчас.
  const stats = await openStats(allowed, metric.id, kind);
  const override = req.overrideLimits && canOverrideLimits(session, settings);
  type Plan = { managerId: string; slotIso: string | null; assignee: string };
  const plans: Plan[] = [];
  for (const id of allowed) {
    const s = stats.get(id) ?? { open: 0, sameDays: new Set<string>(), sameAny: false };
    const nm = nameOf(id) ?? `#${id}`;
    let open = s.open;
    for (const slotIso of practiceSlots) {
      const day = dayOf(slotIso);
      if (kind === 'theory' ? s.sameAny : s.sameDays.has(day)) {
        warnings.push({ managerId: Number(id), code: 'duplicate_metric', message: kind === 'theory'
          ? `${nm}: уже есть открытая задача «${TASKER_KIND_LABELS[kind]}» по «${metric.label}» — вторую не ставим`
          : `${nm}: на ${day.split('-').reverse().join('.')} уже есть «${TASKER_KIND_LABELS[kind]}» по «${metric.label}» — на эту дату вторую не ставим` });
        continue;
      }
      if (open >= MAX_OPEN_TASKS && !override) {
        warnings.push({ managerId: Number(id), code: 'limit_open_tasks', message: `${nm}: уже ${open} открытых задач (лимит ${MAX_OPEN_TASKS})${slotIso && practiceSlots.length > 1 ? ` — дата ${day.split('-').reverse().join('.')} не поставлена` : ''}${canOverrideLimits(session, settings) ? ' — можно обойти галочкой «Поставить сверх лимита»' : ''}` });
        continue;
      }
      open++;
      s.sameDays.add(day);
      plans.push({ managerId: id, slotIso, assignee: assigneeOf(id)! });
    }
  }
  if (!plans.length) return { created: [], warnings };
  const eligible = [...new Set(plans.map(p => p.managerId))];

  // Пересечения (п.3): у исполнителя и у менеджера не может быть двух работ Задачника в одно время (задача,
  // сессия, занятие тренера) — отказ ДО создания чего-либо. Календарь Битрикса — только предупреждение в форме.
  if (kind === 'practice') {
    let sessSlot: { start: string; durationMin: number } | null = null;
    if (req.sessionId) {
      const r = await systemDb().query<{ slot_start: Date; duration_min: number }>('SELECT slot_start, duration_min FROM tasker_sessions WHERE id = $1', [req.sessionId]);
      if (r.rows[0]) sessSlot = { start: r.rows[0].slot_start.toISOString(), durationMin: r.rows[0].duration_min };
    }
    let evSlot: { start: string; durationMin: number } | null = null;
    if (req.trainingEventId) {
      const r = await systemDb().query<{ start_at: Date; duration_min: number }>('SELECT start_at, duration_min FROM tasker_training_events WHERE id = $1', [req.trainingEventId]);
      if (r.rows[0]) evSlot = { start: r.rows[0].start_at.toISOString(), durationMin: r.rows[0].duration_min };
    }
    const problems: string[] = [];
    for (const slotIso of new Set(plans.map(p => p.slotIso))) {
      const base = slotIso ? { start: slotIso, durationMin: req.durationMin } : sessSlot ?? evSlot;
      if (!base) continue;
      const start = Date.parse(base.start);
      const group = plans.filter(p => p.slotIso === slotIso);
      const people = [
        // запись на занятие тренера: исполнитель «Практики» в нём не участвует — проверяем только менеджеров
        ...(evSlot && !slotIso ? [] : [...new Set(group.map(p => p.assignee))].map(id => ({ id, role: 'Исполнитель' }))),
        ...[...new Set(group.map(p => p.managerId))].map(id => ({ id, role: 'Менеджер' })),
      ];
      const msg = await hardConflictMessage(people, [{ start, end: start + base.durationMin * 60_000 }],
        { sessionId: req.sessionId ?? null, trainingEventId: req.trainingEventId ?? null });
      if (msg) problems.push(slotIso && practiceSlots.length > 1 ? `${fmtWhen(slotIso, new Date(start + base.durationMin * 60_000).toISOString())}: ${msg}` : msg);
    }
    if (problems.length) throw new TaskerError(`Время занято — задача не поставлена. ${problems.join(' · ')}. Выберите свободное окно в ленте занятости.`, 'bad_request', 409);
  }

  // Снимок — один прогон отчёта на всех.
  // Тот же кэш, что у формы: снимок в задаче = цифры, которые РОП только что видел.
  const snaps = await computeSnapshots(run, eligible, metric, req.period, { cacheScope: snapshotCacheScope(scope.kind, session.id) });

  // Ручная цель хуже текущего — задача на ухудшение: не ставим никому (кроме «мало данных»). Баг 24.11.
  if (req.target != null) {
    const bad = eligible.filter(id => goalWorseThanCurrent(metric, req.target, stripMeta(snaps[id])));
    if (bad.length) {
      const who = bad.map(id => `${nameOf(id) ?? `#${id}`} (сейчас ${fmtValue(stripMeta(snaps[id]).value, metric.format)})`).join(', ');
      throw new TaskerError(`Цель ${fmtValue(req.target, metric.format)} ${metric.higherIsBetter ? 'ниже' : 'выше'} текущего значения: ${who} — это задача на ухудшение. Поставьте цель не хуже текущего или оставьте поле пустым — цель посчитается сама.`);
    }
  }

  // Записан на занятие тренера → время задачи = время занятия, своей сессии/события нет (менеджер — участник
  // события занятия через запись). Раньше форма слала и своё время, и занятие: у Пуртикова 25.11 задача на 15:00,
  // а в расписании тренера — групповое 16:15.
  // Занятие у каждого менеджера своё: «Теория» без времени раскладывается по слотам ОТДЕЛА менеджера (п.7).
  const eventOf = new Map<string, { id: number; start: string; end: string }>();
  if (req.trainingEventId) {
    const ev = await systemDb().query<{ start_at: Date; duration_min: number; trainer_bitrix_user_id: string | null }>(
      'SELECT start_at, duration_min, trainer_bitrix_user_id FROM tasker_training_events WHERE id = $1 AND cancelled_at IS NULL', [req.trainingEventId]);
    if (!ev.rows[0]) throw new TaskerError('Это занятие отменено или удалено — выберите другое или своё время');
    const st = ev.rows[0].start_at;
    const slot = { id: req.trainingEventId, start: st.toISOString(), end: new Date(st.getTime() + ev.rows[0].duration_min * 60_000).toISOString() };
    // Тренер закрыл запись на это время (299) — в задачу не берём (запись всё равно бы не прошла).
    const tr = ev.rows[0].trainer_bitrix_user_id;
    const closed = tr ? await findClosure(tr, st.getTime(), Date.parse(slot.end)) : null;
    if (closed) throw new TaskerError(closureMessage(closed), 'bad_request', 409);
    if (kind === 'theory') {
      const msg = await hardConflictMessage(eligible.map(id => ({ id, role: 'Менеджер' })), [{ start: st.getTime(), end: Date.parse(slot.end) }], { trainingEventId: req.trainingEventId });
      if (msg) throw new TaskerError(`Время занято — задача не поставлена. ${msg}`, 'bad_request', 409);
    }
    for (const id of eligible) eventOf.set(id, slot);
  } else if (kind === 'theory' && req.slot?.start) {
    // «Теория» со своим временем РОПа → Монолитика сама ставит занятие у тренера (или добавляет в группу на это
    // время и тему) и записывает менеджеров. В очередь тренера такие задачи не попадают (жалоба Будковского 26.11).
    const startIso = toMskIso(req.slot.start, '10:00:00');
    const start = Date.parse(startIso);
    const msg = await hardConflictMessage(eligible.map(id => ({ id, role: 'Менеджер' })), [{ start, end: start + req.durationMin * 60_000 }], {});
    if (msg) throw new TaskerError(`Время занято — задача не поставлена. ${msg}`, 'bad_request', 409);
    const placed = await placeTheoryEvent({
      trainerId: settings.trainerId, startIso, durationMin: req.durationMin,
      metricId: metric.id, metricLabel: metric.label, managers: eligible.length, createdByUserId: session.id, creatorName,
    });
    for (const id of eligible) eventOf.set(id, { id: placed.eventId, start: placed.startIso, end: placed.endIso });
    if (placed.joined) warnings.push({ managerId: null, code: 'training_joined', message: 'На это время у тренера уже стоит занятие по этой теме — менеджеры добавлены в группу' });
  } else if (kind === 'theory') {
    // п.7: «Теория» без времени — сразу в ближайший подходящий слот отдела менеджера (не раньше завтра, тренер
    // свободен, в группе есть место). Не нашёлся — в очередь тренера, как раньше.
    for (const id of eligible) {
      const placed = await autoPlaceTheory({
        trainerId: settings.trainerId, managerId: id, metricId: metric.id, metricLabel: metric.label,
        createdByUserId: session.id, creatorName,
      }).catch(e => { console.warn('[tasker] авторасписание «Теории»:', e instanceof Error ? e.message : e); return null; });
      const nm = nameOf(id) ?? `#${id}`;
      if (placed) {
        eventOf.set(id, { id: placed.eventId, start: placed.startIso, end: placed.endIso });
        warnings.push({ managerId: Number(id), code: 'training_auto', message: `${nm}: записан на занятие ${fmtWhen(placed.startIso, placed.endIso)}${placed.joined ? ' (в группу)' : ''}` });
      } else {
        warnings.push({ managerId: Number(id), code: 'training_queue', message: `${nm}: свободного слота отдела у тренера не нашлось — задача в очереди тренера` });
      }
    }
  }

  const plan = kind === 'practice' ? await practicePlan(metric.id) : null;
  const sessionCache = new Map<string, number>();
  const touchedSessions = new Map<number, number>(); // sessionId → последняя задача запроса
  const createdIds: number[] = [];
  const withEvent: number[] = [];
  const ropCache = new Map<string, string | null>();

  for (const { managerId, slotIso, assignee } of plans) {
    const snapMeta = snaps[managerId];
    const snap = stripMeta(snapMeta);
    const firstForManager = plans.find(p => p.managerId === managerId)?.slotIso === slotIso;
    if (firstForManager) {
      if (snap.value === null && snap.deptAvg === null) {
        warnings.push({ managerId: Number(managerId), code: 'no_snapshot', message: `${nameOf(managerId) ?? `#${managerId}`}: нет данных отчёта за период — задача поставлена без цифр` });
      } else if (!snap.enoughData) {
        warnings.push({ managerId: Number(managerId), code: 'not_enough_data', message: `${nameOf(managerId) ?? `#${managerId}`}: мало данных (знаменатель ${snap.denominator ?? 0} < ${MIN_DENOMINATOR}) — вердикт может быть «мало данных»` });
      }
    }
    // Не передана — по правилу defaultGoal (лучшее из средних; кто уже лучше — +10 % к текущему), у каждого своя.
    const target = req.target ?? defaultGoal(metric, snap).target;
    if (!ropCache.has(managerId)) ropCache.set(managerId, options?.ropByManager?.[managerId] != null ? String(options.ropByManager[managerId]) : await ropOfManager(managerId).catch(() => null));
    const rop = ropCache.get(managerId) ?? null;
    const entry = dir.get(Number(managerId));
    const director = directorFor(settings, entry?.branch);
    const managerName = entry?.name ?? `#${managerId}`;
    const assigneeName = assigneeNameOf(assignee);
    const ev = eventOf.get(managerId) ?? null;
    const trainingEventId = ev?.id ?? null;

    const sess = ev ? null : await resolveSession(ctx, assignee, slotIso, sessionCache);
    const slotStartIso = ev ? ev.start : slotIso ?? sess?.slot ?? null;
    const slotEndIso = ev ? ev.end
      : slotStartIso ? new Date(new Date(slotStartIso).getTime() + req.durationMin * 60_000).toISOString() : null;

    // Чек-лист: только заказчики ЭТОГО менеджера из «горящих» с одной отгрузкой.
    let checklist: { clientKey: string; title: string; crmUrl: string | null }[] = [];
    if (req.customersChecklist?.length) {
      const want = new Set(req.customersChecklist);
      const hot = await loadHotCustomers(managerId, managerName).catch(e => {
        console.warn('[tasker] заказчики повторки:', e instanceof Error ? e.message : e);
        return [];
      });
      checklist = hot.filter(c => want.has(c.clientKey)).map(c => ({ clientKey: c.clientKey, title: c.title, crmUrl: c.crmUrl }));
    }

    // Наблюдатели: директор, РОП менеджера (если он не исполнитель/постановщик), нажавший «от чужого имени».
    // Менеджер наблюдателем НЕ ставится (правка 23.11) — он участник события календаря.
    const auditorSet = new Set<string>();
    const skip = new Set([assignee, creatorBx, managerId].filter((x): x is string => !!x));
    for (const a of [director, rop, onBehalf ? clickerBx : null]) if (a && !skip.has(a)) auditorSet.add(a);
    const auditors = [...auditorSet];

    // Срок не раньше конца встречи (дата «чт» при сроке «ср» — задача не должна родиться просроченной).
    const taskDeadline = slotEndIso && Date.parse(slotEndIso) > Date.parse(deadlineIso) ? slotEndIso : deadlineIso;
    const marker = `TSK-${randomUUID().slice(0, 8)}`;
    const title = `${metric.label}: подтянуть до ${fmtValue(target, metric.format)} — ${managerName}`;
    const reqT: TaskerCreateRequest = { ...req, trainingEventId };
    const ins = await systemDb().query<{ id: string }>(
      `INSERT INTO tasker_tasks (marker, manager_bitrix_id, manager_name, rop_bitrix_id, rop_name, director_bitrix_id, director_name,
          creator_bitrix_id, creator_user_id, creator_name, dept_name, metric_id, period_from, period_to, snapshot, target, template_id,
          title, body, deadline, duration_min, slot_start, slot_end, control_date, session_id, training_event_id, checklist,
          kind, executor_bitrix_id, executor_name, auditor_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,
          $28,$29,$30,$31::text[])
       RETURNING id`,
      [marker, managerId, managerName, rop, nameOf(rop), director, nameOf(director),
        creatorBx, session.id, creatorName, snap.deptName ?? entry?.departmentName ?? null,
        metric.id, req.period.from, req.period.to, JSON.stringify(snap), target, req.templateId,
        title, req.body, taskDeadline, req.durationMin, slotStartIso, slotEndIso, req.controlDate, sess?.id ?? null,
        trainingEventId, JSON.stringify(checklist), kind, assignee, assigneeName, auditors]);
    const taskId = Number(ins.rows[0].id);
    createdIds.push(taskId);
    if (trainingEventId) withEvent.push(taskId);
    if (sess) touchedSessions.set(sess.id, taskId);

    const crm = checklist.map(c => crmBindingOf(c.clientKey)).filter((x): x is string => !!x);
    const fields: Record<string, unknown> = {
      TITLE: title,
      DESCRIPTION: describe({ metric, snap, target, req: reqT, managerName, taskId, marker, kind, assigneeName, managerId, plan,
        slot: slotStartIso && slotEndIso ? { start: slotStartIso, end: slotEndIso } : null }),
      RESPONSIBLE_ID: Number(assignee),
      ...(creatorBx ? { CREATED_BY: Number(creatorBx) } : {}),
      ...(auditors.length ? { AUDITORS: auditors.map(Number) } : {}),
      TAGS: [metric.tag],
      ALLOW_TIME_TRACKING: 'Y',
      TIME_ESTIMATE: req.durationMin * 60,
      ...(slotStartIso && slotEndIso ? { START_DATE_PLAN: bxDate(slotStartIso), END_DATE_PLAN: bxDate(slotEndIso) } : {}),
      DEADLINE: bxDate(taskDeadline),
      TASK_CONTROL: 'N',
      ...(crm.length ? { UF_CRM_TASK: crm } : {}),
    };
    const ops: BxOp[] = [{ op: 'create_task', fields, marker, creatorBitrixId: creatorBx }];
    if (checklist.length) {
      ops.push({ op: 'checklist', items: checklist.map(c => `${c.title}${c.crmUrl ? ` — ${c.crmUrl}` : ''}`) });
    }
    // Слот без сессии — своё событие в календаре исполнителя, менеджер — участник (п.10 правок 23.11).
    if (!sess && !ev && slotStartIso) ops.push({ op: 'task_calendar' });
    await enqueue(taskId, ops);
    const res = await drainTask(taskId, { force: true }).catch(e => ({ done: 0, error: e instanceof Error ? e.message : String(e) }));
    if (res.error) {
      warnings.push({ managerId: Number(managerId), code: 'bitrix_failed', message: `${managerName}: задача сохранена в Монолитике, но Битрикс пока не принял (${res.error}) — повторим автоматически` });
    }
  }

  // Задачи на занятие тренера — сразу записываем менеджеров (иначе запись ждала бы фонового тика); календарь тренера
  // обновит syncTrainingCalendar внутри (менеджеры — участники одного события).
  if (withEvent.length) {
    await syncTaskEnrollments(withEvent.length, withEvent).catch(e =>
      console.warn('[tasker] запись на занятие из задачи:', e instanceof Error ? e.message : e));
  }

  // Сессия = одно событие в календаре РОПа (фаза 1b): ставим/обновляем после того, как задачи получили id в
  // Битриксе (ссылки в описании). Операция — в очереди последней задачи этой сессии из запроса.
  for (const [sessionId, taskId] of touchedSessions) {
    await refreshSessionDuration(sessionId);
    await enqueue(taskId, [{ op: 'calendar', sessionId }]);
    const res = await drainTask(taskId, { force: true }).catch(e => ({ done: 0, error: e instanceof Error ? e.message : String(e) }));
    if (res.error) warnings.push({ managerId: null, code: 'bitrix_failed', message: `Событие сессии в календаре исполнителя пока не поставлено (${res.error}) — повторим автоматически` });
  }
  invalidateLive(settings.groupId);
  // п.2: сообщение менеджерам — сразу, не дожидаясь минутного тика (ошибка бота задачу не валит).
  await notifyManagersNow(eligible).catch(e => console.warn('[tasker] уведомление менеджерам:', e instanceof Error ? e.message : e));
  const viewer = viewerOf(session);
  const created = (await Promise.all(createdIds.map(id => getTask(id, viewer)))).filter((t): t is TaskerTask => !!t);
  return { created, warnings };
}

/** Контрольная дата по умолчанию: срок + 7 дней (для формы; сервер принимает явную). */
export function defaultControlDate(deadlineYmd: string): string {
  return addDaysYmd(deadlineYmd, DEFAULT_CONTROL_DAYS);
}
