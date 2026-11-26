// Тесты Задачника — движок (TASKER_SPEC.md «Тесты», миграция 300).
//
// Права:
//  - создавать/править/публиковать/архивировать, назначать любым, видеть все результаты, разрешать пересдачу —
//    тренер (action.tasker.trainings.manage), action.tasker.tests.manage, супер-админ (hasPerm);
//  - назначать вручную и видеть результаты — РОП/директор (срез сессии не «только себя») и носитель
//    action.tasker.assign — только видимым им менеджерам (canSeeManager);
//  - проходить — сам менеджер (assignment.manager = session.bitrixUserId), из ЛК.
// Правильные ответы и пояснения уходят только тем, кто ведёт тесты; менеджер после отправки видит балл и номера
// вопросов с ошибкой (не сами ответы — чтобы не утекали коллегам).
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import { getSalesDepartmentOptions, resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { canSeeDept, canSeeManager, getSessionScope, type SessionScope } from '@/lib/org/sessionScope';
import { appBaseUrl } from '../../engine/config';
import type {
  AssignmentState, MyTestDetailResponse, MyTestRow, TakeQuestion, TestAssignOptionsResponse, TestAssignRequest,
  TestAssignResponse, TestAssignmentRow, TestAttemptResult, TestFull, TestQuestion, TestQuestionStat, TestResultsResponse,
  TestSaveRequest, TestSettings, TestStatus, TestSummary, TrainingTestLink, TrainingTestPeriodRow, TrainingTestStats,
} from '../types';

export class TestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface TestActor {
  session: SessionUser;
  scope: SessionScope;
  canManage: boolean;
  canAssign: boolean;
}

export function canManageTests(session: SessionUser): boolean {
  return hasPerm(session, 'action.tasker.trainings.manage') || hasPerm(session, 'action.tasker.tests.manage');
}

export async function getTestActor(session: SessionUser): Promise<TestActor> {
  const scope = await getSessionScope(session);
  const canManage = canManageTests(session);
  const canAssign = canManage || hasPerm(session, 'action.tasker.assign') || scope.kind !== 'self';
  return { session, scope, canManage, canAssign };
}

const canTouch = (a: TestActor, managerId: string) => a.canManage || canSeeManager(a.scope, managerId);
const DAY = 86_400_000;
/** Запас на сеть при отправке по таймеру: ответы, пришедшие чуть позже лимита, ещё принимаются. */
const GRACE_MS = 60_000;

// ── Нормализация ───────────────────────────────────────────────────────────

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const IMG_RE = /^(https:\/\/[^/\s]+)?\/api\/tasker\/templates\/images\/[0-9a-f-]{36}$/i;

/** Мягкая нормализация (черновик можно сохранить недописанным). */
function normalizeQuestions(raw: unknown): TestQuestion[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new TestError('Вопросы — списком');
  if (raw.length > 100) throw new TestError('Не больше 100 вопросов');
  const seen = new Set<string>();
  return raw.map((q0): TestQuestion => {
    const q = (q0 && typeof q0 === 'object' ? q0 : {}) as Record<string, unknown>;
    let id = str(q.id, 40);
    if (!id || seen.has(id)) id = randomUUID().slice(0, 12);
    seen.add(id);
    const img = str(q.imageUrl, 300);
    if (img && !IMG_RE.test(img)) throw new TestError('Картинка вопроса — только загруженная в Монолитику');
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length > 10) throw new TestError('Не больше 10 вариантов ответа');
    const oSeen = new Set<string>();
    return {
      id,
      kind: q.kind === 'multi' ? 'multi' : 'single',
      text: str(q.text, 2000),
      imageUrl: img || null,
      explanation: str(q.explanation, 2000),
      options: opts.map(o0 => {
        const o = (o0 && typeof o0 === 'object' ? o0 : {}) as Record<string, unknown>;
        let oid = str(o.id, 40);
        if (!oid || oSeen.has(oid)) oid = randomUUID().slice(0, 8);
        oSeen.add(oid);
        return { id: oid, text: str(o.text, 500), correct: o.correct === true };
      }),
    };
  });
}

/** Строгая проверка перед публикацией. */
function validateForPublish(qs: TestQuestion[], title: string): void {
  if (!title) throw new TestError('Нужно название теста');
  if (!qs.length) throw new TestError('В тесте нет вопросов');
  qs.forEach((q, i) => {
    const n = `Вопрос ${i + 1}`;
    if (!q.text) throw new TestError(`${n}: нет текста`);
    if (q.options.length < 2) throw new TestError(`${n}: нужно хотя бы 2 варианта`);
    if (q.options.some(o => !o.text)) throw new TestError(`${n}: пустой вариант ответа`);
    const c = q.options.filter(o => o.correct).length;
    if (q.kind === 'single' && c !== 1) throw new TestError(`${n}: отметьте ровно один правильный вариант`);
    if (q.kind === 'multi' && c < 1) throw new TestError(`${n}: отметьте хотя бы один правильный вариант`);
  });
}

function cleanSettings(raw: Record<string, unknown>): Partial<TestSettings> {
  const out: Partial<TestSettings> = {};
  if ('title' in raw) {
    out.title = str(raw.title, 200);
    if (!out.title) throw new TestError('Нужно название теста');
  }
  if ('description' in raw) out.description = str(raw.description, 4000);
  if ('metricId' in raw) out.metricId = str(raw.metricId, 120) || null;
  if ('passPercent' in raw) {
    const n = Number(raw.passPercent);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new TestError('Проходной балл — от 1 до 100%');
    out.passPercent = n;
  }
  if ('timeLimitMin' in raw) {
    if (raw.timeLimitMin === null || raw.timeLimitMin === '' || raw.timeLimitMin === 0) out.timeLimitMin = null;
    else {
      const n = Number(raw.timeLimitMin);
      if (!Number.isInteger(n) || n < 1 || n > 240) throw new TestError('Лимит времени — от 1 до 240 минут');
      out.timeLimitMin = n;
    }
  }
  for (const k of ['shuffleQuestions', 'shuffleOptions', 'isCertification'] as const) {
    if (k in raw) out[k] = raw[k] === true;
  }
  return out;
}

// ── Тесты: чтение ──────────────────────────────────────────────────────────

interface TestRow {
  id: string; title: string; description: string; metric_id: string | null; pass_percent: number;
  time_limit_min: number | null; shuffle_questions: boolean; shuffle_options: boolean; is_certification: boolean;
  status: TestStatus; questions: TestQuestion[]; current_version_id: string | null; updated_at: Date;
  v_version: number | null; v_title: string | null; v_pass: number | null; v_limit: number | null;
  v_sq: boolean | null; v_so: boolean | null; v_questions: TestQuestion[] | null;
}

const TEST_SELECT = `
  SELECT t.id, t.title, t.description, t.metric_id, t.pass_percent, t.time_limit_min, t.shuffle_questions,
         t.shuffle_options, t.is_certification, t.status, t.questions, t.current_version_id, t.updated_at,
         v.version AS v_version, v.title AS v_title, v.pass_percent AS v_pass, v.time_limit_min AS v_limit,
         v.shuffle_questions AS v_sq, v.shuffle_options AS v_so, v.questions AS v_questions
    FROM tasker_tests t
    LEFT JOIN tasker_test_versions v ON v.id = t.current_version_id`;

function settingsOf(r: TestRow): TestSettings {
  return {
    title: r.title, description: r.description, metricId: r.metric_id, passPercent: r.pass_percent,
    timeLimitMin: r.time_limit_min, shuffleQuestions: r.shuffle_questions, shuffleOptions: r.shuffle_options,
    isCertification: r.is_certification,
  };
}

function hasUnpublished(r: TestRow): boolean {
  if (r.v_version == null) return r.status !== 'archived' && r.questions.length > 0;
  return r.title !== r.v_title || r.pass_percent !== r.v_pass || r.time_limit_min !== r.v_limit
    || r.shuffle_questions !== r.v_sq || r.shuffle_options !== r.v_so
    || JSON.stringify(r.questions) !== JSON.stringify(r.v_questions);
}

interface AggRow { test_id: string; assigned: string; completed: string; passed: string; avg: string | null }

/** Сводка по назначениям (в срезе пользователя). */
async function testAggregates(actor: TestActor, testIds: string[]): Promise<Map<string, AggRow>> {
  if (!testIds.length) return new Map();
  const r = await systemDb().query<AggRow & { manager_bitrix_user_id: string; score: string | null; done: boolean; ok: boolean | null }>(
    `SELECT a.test_id, a.manager_bitrix_user_id, l.score_percent AS score, l.id IS NOT NULL AS done, l.passed AS ok
       FROM tasker_test_assignments a
       LEFT JOIN LATERAL (SELECT x.id, x.score_percent, x.passed FROM tasker_test_attempts x
                           WHERE x.assignment_id = a.id AND x.submitted_at IS NOT NULL
                           ORDER BY x.submitted_at DESC LIMIT 1) l ON true
      WHERE a.test_id = ANY($1::bigint[]) AND a.cancelled_at IS NULL`,
    [testIds],
  );
  const m = new Map<string, { assigned: number; completed: number; passed: number; sum: number }>();
  for (const x of r.rows) {
    if (!canTouch(actor, x.manager_bitrix_user_id)) continue;
    const g = m.get(x.test_id) ?? { assigned: 0, completed: 0, passed: 0, sum: 0 };
    g.assigned++;
    if (x.done) { g.completed++; g.sum += Number(x.score ?? 0); if (x.ok) g.passed++; }
    m.set(x.test_id, g);
  }
  return new Map([...m].map(([k, g]) => [k, {
    test_id: k, assigned: String(g.assigned), completed: String(g.completed), passed: String(g.passed),
    avg: g.completed ? String(g.sum / g.completed) : null,
  }]));
}

function toSummary(r: TestRow, agg: AggRow | undefined): TestSummary {
  return {
    id: Number(r.id),
    ...settingsOf(r),
    status: r.status,
    questionCount: (r.v_questions ?? r.questions).length,
    version: r.v_version,
    hasUnpublished: hasUnpublished(r),
    assigned: Number(agg?.assigned ?? 0),
    completed: Number(agg?.completed ?? 0),
    passed: Number(agg?.passed ?? 0),
    avgScore: agg?.avg != null ? Math.round(Number(agg.avg) * 10) / 10 : null,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listTests(actor: TestActor): Promise<TestSummary[]> {
  if (!actor.canAssign) return [];
  // Назначающему (РОП) — только опубликованные: черновики тренера ему ни к чему.
  const r = await systemDb().query<TestRow>(
    `${TEST_SELECT} ${actor.canManage ? '' : `WHERE t.status = 'published'`} ORDER BY t.status = 'archived', t.updated_at DESC LIMIT 500`,
  );
  const agg = await testAggregates(actor, r.rows.map(x => x.id));
  return r.rows.map(x => toSummary(x, agg.get(x.id)));
}

async function loadTestRow(id: number): Promise<TestRow> {
  const r = await systemDb().query<TestRow>(`${TEST_SELECT} WHERE t.id = $1`, [id]);
  if (!r.rows[0]) throw new TestError('Тест не найден', 404);
  return r.rows[0];
}

export async function getTest(actor: TestActor, id: number): Promise<TestFull> {
  if (!actor.canManage) throw new TestError('Тест открыт только тренеру', 403);
  const row = await loadTestRow(id);
  const agg = await testAggregates(actor, [row.id]);
  return { ...toSummary(row, agg.get(row.id)), questions: row.questions };
}

// ── Тесты: запись ──────────────────────────────────────────────────────────

export async function createTest(actor: TestActor, raw: unknown): Promise<TestFull> {
  if (!actor.canManage) throw new TestError('Создавать тесты может тренер', 403);
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = cleanSettings({ title: b.title ?? '', ...b });
  const qs = normalizeQuestions(b.questions);
  const r = await systemDb().query<{ id: string }>(
    `INSERT INTO tasker_tests (title, description, metric_id, pass_percent, time_limit_min, shuffle_questions,
                               shuffle_options, is_certification, questions, created_by, updated_by)
     VALUES ($1, $2, $3, COALESCE($4, 80), $5, COALESCE($6, true), COALESCE($7, true), COALESCE($8, false), $9, $10, $10)
     RETURNING id`,
    [s.title, s.description ?? '', s.metricId ?? null, s.passPercent ?? null, s.timeLimitMin ?? null,
      s.shuffleQuestions ?? null, s.shuffleOptions ?? null, s.isCertification ?? null, JSON.stringify(qs), actor.session.id],
  );
  return getTest(actor, Number(r.rows[0].id));
}

export async function updateTest(actor: TestActor, id: number, raw: unknown): Promise<TestFull> {
  if (!actor.canManage) throw new TestError('Править тесты может тренер', 403);
  const b = (raw && typeof raw === 'object' ? raw : {}) as TestSaveRequest & Record<string, unknown>;
  const s = cleanSettings(b);
  const db = systemDb();
  await loadTestRow(id);
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
  if (s.title !== undefined) set('title', s.title);
  if (s.description !== undefined) set('description', s.description);
  if (s.metricId !== undefined) set('metric_id', s.metricId);
  if (s.passPercent !== undefined) set('pass_percent', s.passPercent);
  if (s.timeLimitMin !== undefined) set('time_limit_min', s.timeLimitMin);
  if (s.shuffleQuestions !== undefined) set('shuffle_questions', s.shuffleQuestions);
  if (s.shuffleOptions !== undefined) set('shuffle_options', s.shuffleOptions);
  if (s.isCertification !== undefined) set('is_certification', s.isCertification);
  if (b.questions !== undefined) set('questions', JSON.stringify(normalizeQuestions(b.questions)));
  if (b.action === 'archive') set('status', 'archived');
  if (sets.length) {
    set('updated_by', actor.session.id);
    args.push(id);
    await db.query(`UPDATE tasker_tests SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length}`, args);
  }
  if (b.action === 'unarchive') {
    await db.query(
      `UPDATE tasker_tests SET status = CASE WHEN current_version_id IS NULL THEN 'draft' ELSE 'published' END,
              updated_by = $2, updated_at = now() WHERE id = $1`, [id, actor.session.id]);
  }
  if (b.action === 'publish') await publish(actor, id);
  return getTest(actor, id);
}

/** Опубликовать рабочую копию: по текущей версии нет попыток — переписываем её, есть — новая версия. */
async function publish(actor: TestActor, id: number): Promise<void> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query<TestRow>(`SELECT * FROM tasker_tests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!t) throw new TestError('Тест не найден', 404);
    validateForPublish(t.questions, t.title);
    const snap = [t.title, t.pass_percent, t.time_limit_min, t.shuffle_questions, t.shuffle_options, JSON.stringify(t.questions)];
    let versionId: string | null = null;
    if (t.current_version_id) {
      const used = await client.query(`SELECT 1 FROM tasker_test_attempts WHERE version_id = $1 LIMIT 1`, [t.current_version_id]);
      if (!used.rowCount) {
        await client.query(
          `UPDATE tasker_test_versions SET title = $2, pass_percent = $3, time_limit_min = $4, shuffle_questions = $5,
                  shuffle_options = $6, questions = $7, created_by = $8, created_at = now() WHERE id = $1`,
          [t.current_version_id, ...snap, actor.session.id]);
        versionId = t.current_version_id;
      }
    }
    if (!versionId) {
      const v = await client.query<{ id: string }>(
        `INSERT INTO tasker_test_versions (test_id, version, title, pass_percent, time_limit_min, shuffle_questions,
                                           shuffle_options, questions, created_by)
         VALUES ($1, COALESCE((SELECT max(version) FROM tasker_test_versions WHERE test_id = $1), 0) + 1,
                 $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [id, ...snap, actor.session.id]);
      versionId = v.rows[0].id;
    }
    await client.query(
      `UPDATE tasker_tests SET current_version_id = $2, status = 'published', updated_by = $3, updated_at = now() WHERE id = $1`,
      [id, versionId, actor.session.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Назначения ─────────────────────────────────────────────────────────────

export async function assignOptions(actor: TestActor): Promise<TestAssignOptionsResponse> {
  if (!actor.canAssign) return { managers: [], departments: [] };
  const [dir, depts] = await Promise.all([getEmployeeDirectory(), getSalesDepartmentOptions()]);
  const visibleDepts = depts.filter(d => actor.canManage || canSeeDept(actor.scope, d.id));
  const sales = await resolveManagersForDepartments(depts.map(d => d.id));
  const seen = new Set<string>();
  const managers: TestAssignOptionsResponse['managers'] = [];
  for (const m of sales) {
    if (seen.has(m.managerId) || !canTouch(actor, m.managerId)) continue;
    seen.add(m.managerId);
    const id = Number(m.managerId);
    if (!Number.isFinite(id)) continue;
    const name = dir.get(id)?.name ?? m.name;
    if (/^User \d+$/.test(name)) continue;
    managers.push({ id, name, departmentName: dir.get(id)?.departmentName ?? null });
  }
  managers.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { managers, departments: visibleDepts.map(d => ({ id: d.id, name: d.name, path: d.path ?? null })) };
}

interface NewAssignment { managerId: string; trainingEventId: number | null; dueAt: Date }

/** Вставить назначения (пропуская тех, у кого этот тест уже висит незавершённым) и уведомить. */
async function insertAssignments(
  testId: number, items: NewAssignment[], assignedBy: string | null, source: 'manual' | 'training',
): Promise<TestAssignResponse> {
  if (!items.length) return { created: 0, skipped: 0 };
  const db = systemDb();
  const created: { id: string; manager_bitrix_user_id: string; due_at: Date }[] = [];
  let skipped = 0;
  for (const it of items) {
    // Тест уже висит непройденным (ни одной отправленной попытки) — второе назначение не ставим.
    const r = await db.query<{ id: string; manager_bitrix_user_id: string; due_at: Date }>(
      `INSERT INTO tasker_test_assignments (test_id, manager_bitrix_user_id, source, training_event_id, assigned_by, due_at)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (
          SELECT 1 FROM tasker_test_assignments a
           WHERE a.test_id = $1 AND a.manager_bitrix_user_id = $2 AND a.cancelled_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM tasker_test_attempts x WHERE x.assignment_id = a.id AND x.submitted_at IS NOT NULL))
          AND ($4::bigint IS NULL OR NOT EXISTS (
          SELECT 1 FROM tasker_test_assignments a
           WHERE a.test_id = $1 AND a.manager_bitrix_user_id = $2 AND a.training_event_id = $4))
       ON CONFLICT DO NOTHING
       RETURNING id, manager_bitrix_user_id, due_at`,
      [testId, it.managerId, source, it.trainingEventId, assignedBy, it.dueAt],
    );
    if (r.rows[0]) created.push(r.rows[0]); else skipped++;
  }
  if (created.length) {
    const t = await db.query<{ title: string; n: number; time_limit_min: number | null }>(
      `SELECT t.title, jsonb_array_length(COALESCE(v.questions, t.questions)) AS n, COALESCE(v.time_limit_min, t.time_limit_min) AS time_limit_min
         FROM tasker_tests t LEFT JOIN tasker_test_versions v ON v.id = t.current_version_id WHERE t.id = $1`, [testId]);
    const info = t.rows[0];
    // Уведомления — параллельно, ошибка бота не отменяет назначение (пишется в notify_error).
    await Promise.allSettled(created.map(a => notifyAssigned(a.id, a.manager_bitrix_user_id, info, a.due_at)));
  }
  return { created: created.length, skipped };
}

const fmtDue = (d: Date) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function notifyAssigned(
  assignmentId: string, managerId: string, info: { title: string; n: number; time_limit_min: number | null } | undefined, due: Date,
  retake = false,
): Promise<void> {
  const db = systemDb();
  try {
    const { sendBitrixBotMessage } = await import('@/lib/bitrix/notify');
    const link = `${appBaseUrl()}/profile/tests/${assignmentId}`;
    const lines = [
      retake ? `[B]Разрешена пересдача теста[/B] «${info?.title ?? 'Тест'}»` : `[B]Вам назначен тест[/B] «${info?.title ?? 'Тест'}»`,
      `Пройти до ${fmtDue(due)} МСК · вопросов: ${info?.n ?? '?'}${info?.time_limit_min ? ` · на всё ${info.time_limit_min} мин.` : ''}`,
      'Попытка одна — проходите, когда будет 10–15 спокойных минут.',
      `[URL=${link}]Открыть тест[/URL]`,
    ];
    const sent = await sendBitrixBotMessage(managerId, lines.join('\n'), undefined, 'tasker_tests',
      { kind: retake ? 'tasker_test_retake' : 'tasker_test_assigned', entityType: 'tasker_test_assignment', entityId: assignmentId });
    await db.query(`UPDATE tasker_test_assignments SET notified_at = now(), notify_error = $2 WHERE id = $1`,
      [assignmentId, sent ? null : 'функция бота tasker_tests выключена']);
  } catch (e) {
    await db.query(`UPDATE tasker_test_assignments SET notify_error = $2 WHERE id = $1`,
      [assignmentId, (e instanceof Error ? e.message : String(e)).slice(0, 500)]).catch(() => {});
  }
}

async function publishedTest(testId: number): Promise<TestRow> {
  const t = await loadTestRow(testId);
  if (t.status !== 'published' || !t.current_version_id) throw new TestError('Назначить можно только опубликованный тест');
  return t;
}

function cleanDueDays(raw: unknown, def = 3): number {
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new TestError('Срок прохождения — от 1 до 30 дней');
  return n;
}

/** Срок: конец дня МСК через N дней. */
function dueAtDays(days: number, from = Date.now()): Date {
  const msk = new Date(from + 3 * 3600_000 + days * DAY);
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), 20, 59, 0)); // 23:59 МСК
}

export async function assignTest(actor: TestActor, testId: number, raw: unknown): Promise<TestAssignResponse> {
  if (!actor.canAssign) throw new TestError('Назначать тесты может тренер или руководитель', 403);
  const b = (raw && typeof raw === 'object' ? raw : {}) as TestAssignRequest;
  await publishedTest(testId);
  const due = dueAtDays(cleanDueDays(b.dueDays));
  const ids = new Set<string>();
  for (const m of Array.isArray(b.managerIds) ? b.managerIds : []) {
    const s = String(m);
    if (!/^\d+$/.test(s)) throw new TestError('Некорректный менеджер');
    if (!canTouch(actor, s)) throw new TestError('Назначать можно только своим менеджерам', 403);
    ids.add(s);
  }
  const depts = (Array.isArray(b.departmentIds) ? b.departmentIds : []).map(String);
  if (depts.length) {
    if (!actor.canManage && depts.some(d => !canSeeDept(actor.scope, d))) throw new TestError('Назначать можно только своим отделам', 403);
    for (const m of await resolveManagersForDepartments(depts)) if (canTouch(actor, m.managerId)) ids.add(m.managerId);
  }
  if (!ids.size) throw new TestError('Выберите менеджеров или отдел');
  if (ids.size > 300) throw new TestError('Слишком много за раз (больше 300)');
  return insertAssignments(testId, [...ids].map(managerId => ({ managerId, trainingEventId: null, dueAt: due })), actor.session.id, 'manual');
}

export async function cancelAssignment(actor: TestActor, id: number): Promise<void> {
  const a = await loadAssignment(id);
  if (!(actor.canManage || (actor.canAssign && canSeeManager(actor.scope, a.manager_bitrix_user_id)))) {
    throw new TestError('Нет доступа к назначению', 403);
  }
  await systemDb().query(
    `UPDATE tasker_test_assignments SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1 AND cancelled_at IS NULL`,
    [id, actor.session.id]);
}

export async function allowRetake(actor: TestActor, id: number, rawDueDays: unknown): Promise<void> {
  if (!actor.canManage) throw new TestError('Пересдачу разрешает тренер', 403);
  const a = await loadAssignment(id);
  if (a.cancelled_at) throw new TestError('Назначение отменено');
  const due = dueAtDays(cleanDueDays(rawDueDays));
  const r = await systemDb().query(
    `UPDATE tasker_test_assignments SET retakes_allowed = retakes_allowed + 1, due_at = $2
      WHERE id = $1 AND retakes_allowed < 10
        AND (SELECT count(*) FROM tasker_test_attempts x WHERE x.assignment_id = $1 AND x.submitted_at IS NOT NULL) >= retakes_allowed + 1`,
    [id, due]);
  if (!r.rowCount) throw new TestError('Пересдача уже доступна (или лимит 10 исчерпан)');
  const t = await systemDb().query<{ title: string; n: number; time_limit_min: number | null }>(
    `SELECT t.title, jsonb_array_length(v.questions) AS n, v.time_limit_min
       FROM tasker_tests t JOIN tasker_test_versions v ON v.id = t.current_version_id WHERE t.id = $1`, [a.test_id]);
  await notifyAssigned(String(id), a.manager_bitrix_user_id, t.rows[0], due, true);
}

// ── Попытки ────────────────────────────────────────────────────────────────

interface AssignmentDb {
  id: string; test_id: string; manager_bitrix_user_id: string; source: 'manual' | 'training';
  training_event_id: string | null; assigned_at: Date; due_at: Date; retakes_allowed: number;
  cancelled_at: Date | null; assigned_by_name: string | null;
  title: string; description: string; current_version_id: string | null;
  n: number; time_limit_min: number | null; pass_percent: number; training_title: string | null;
}

const ASSIGNMENT_SELECT = `
  SELECT a.id, a.test_id, a.manager_bitrix_user_id, a.source, a.training_event_id, a.assigned_at, a.due_at,
         a.retakes_allowed, a.cancelled_at, u.display_name AS assigned_by_name,
         COALESCE(v.title, t.title) AS title, t.description, t.current_version_id,
         jsonb_array_length(COALESCE(v.questions, t.questions)) AS n,
         COALESCE(v.time_limit_min, t.time_limit_min) AS time_limit_min, COALESCE(v.pass_percent, t.pass_percent) AS pass_percent,
         e.title AS training_title
    FROM tasker_test_assignments a
    JOIN tasker_tests t ON t.id = a.test_id
    LEFT JOIN tasker_test_versions v ON v.id = t.current_version_id
    LEFT JOIN tasker_training_events e ON e.id = a.training_event_id
    LEFT JOIN users u ON u.id = a.assigned_by`;

async function loadAssignment(id: number): Promise<AssignmentDb> {
  const r = await systemDb().query<AssignmentDb>(`${ASSIGNMENT_SELECT} WHERE a.id = $1`, [id]);
  if (!r.rows[0]) throw new TestError('Назначение не найдено', 404);
  return r.rows[0];
}

interface AttemptDb {
  id: string; assignment_id: string; version_id: string; version: number; started_at: Date; deadline_at: Date | null;
  submitted_at: Date | null; auto_submitted: boolean; question_order: { q: string; o: string[] }[];
  answers: Record<string, string[]>; correct_count: number | null; total_count: number | null;
  score_percent: string | null; passed: boolean | null; wrong_question_ids: string[] | null;
}

async function loadAttempts(assignmentIds: string[]): Promise<Map<string, AttemptDb[]>> {
  const out = new Map<string, AttemptDb[]>();
  if (!assignmentIds.length) return out;
  const r = await systemDb().query<AttemptDb>(
    `SELECT x.*, v.version FROM tasker_test_attempts x JOIN tasker_test_versions v ON v.id = x.version_id
      WHERE x.assignment_id = ANY($1::bigint[]) ORDER BY x.started_at`, [assignmentIds]);
  for (const a of r.rows) out.set(a.assignment_id, [...(out.get(a.assignment_id) ?? []), a]);
  return out;
}

const attemptResult = (x: AttemptDb): TestAttemptResult => ({
  id: Number(x.id), version: x.version, startedAt: x.started_at.toISOString(),
  submittedAt: x.submitted_at?.toISOString() ?? null, autoSubmitted: x.auto_submitted,
  scorePercent: x.score_percent != null ? Number(x.score_percent) : null,
  correct: x.correct_count, total: x.total_count, passed: x.passed,
});

function stateOf(a: AssignmentDb, attempts: AttemptDb[]): { state: AssignmentState; last: AttemptDb | null; open: AttemptDb | null; used: number } {
  const open = attempts.find(x => !x.submitted_at) ?? null;
  const done = attempts.filter(x => x.submitted_at);
  const last = done.length ? done[done.length - 1] : null;
  const state: AssignmentState = a.cancelled_at ? 'cancelled'
    : open ? 'in_progress'
    : last ? (last.passed ? 'passed' : 'failed')
    : a.due_at.getTime() < Date.now() ? 'overdue' : 'assigned';
  return { state, last, open, used: done.length };
}

/** Закрыть попытки с истёкшим временем (сохранёнными ответами) — лениво при чтении и в тике. */
export async function finalizeExpired(): Promise<number> {
  const db = systemDb();
  const r = await db.query<{ id: string }>(
    `SELECT id FROM tasker_test_attempts
      WHERE submitted_at IS NULL AND deadline_at IS NOT NULL AND deadline_at < now() - interval '${GRACE_MS / 1000} seconds'
      LIMIT 200`);
  for (const x of r.rows) await scoreAndClose(x.id, true).catch(e => console.error('[tasker/tests finalize]', e));
  return r.rows.length;
}

async function scoreAndClose(attemptId: string, auto: boolean): Promise<void> {
  const db = systemDb();
  const r = await db.query<{ answers: Record<string, string[]>; questions: TestQuestion[]; pass_percent: number }>(
    `SELECT x.answers, v.questions, v.pass_percent FROM tasker_test_attempts x JOIN tasker_test_versions v ON v.id = x.version_id
      WHERE x.id = $1 AND x.submitted_at IS NULL`, [attemptId]);
  const row = r.rows[0];
  if (!row) return;
  const wrong: string[] = [];
  for (const q of row.questions) {
    const right = new Set(q.options.filter(o => o.correct).map(o => o.id));
    const got = new Set(row.answers[q.id] ?? []);
    const ok = right.size === got.size && [...right].every(id => got.has(id));
    if (!ok) wrong.push(q.id);
  }
  const total = row.questions.length;
  const correct = total - wrong.length;
  const score = total ? Math.round((correct / total) * 10000) / 100 : 0;
  await db.query(
    `UPDATE tasker_test_attempts SET submitted_at = now(), auto_submitted = $2, correct_count = $3, total_count = $4,
            score_percent = $5, passed = $6, wrong_question_ids = $7
      WHERE id = $1 AND submitted_at IS NULL`,
    [attemptId, auto, correct, total, score, score >= row.pass_percent, wrong]);
}

function shuffle<T>(a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

function ownAssignment(session: SessionUser, a: AssignmentDb): void {
  if (!session.bitrixUserId || a.manager_bitrix_user_id !== String(session.bitrixUserId)) {
    throw new TestError('Это назначение другого сотрудника', 403);
  }
}

function myRow(a: AssignmentDb, attempts: AttemptDb[]): MyTestRow {
  const s = stateOf(a, attempts);
  return {
    assignmentId: Number(a.id),
    testTitle: a.title,
    description: a.description,
    questionCount: a.n,
    timeLimitMin: a.time_limit_min,
    passPercent: a.pass_percent,
    dueAt: a.due_at.toISOString(),
    state: s.state,
    trainingTitle: a.training_title,
    last: s.last ? attemptResult(s.last) : null,
    canStart: !a.cancelled_at && !!a.current_version_id && (!!s.open || s.used < 1 + a.retakes_allowed),
  };
}

export async function myTests(session: SessionUser): Promise<{ rows: MyTestRow[]; pending: number }> {
  if (!session.bitrixUserId) return { rows: [], pending: 0 };
  await finalizeExpired();
  const r = await systemDb().query<AssignmentDb>(
    `${ASSIGNMENT_SELECT} WHERE a.manager_bitrix_user_id = $1 AND a.cancelled_at IS NULL ORDER BY a.assigned_at DESC LIMIT 200`,
    [String(session.bitrixUserId)]);
  const att = await loadAttempts(r.rows.map(x => x.id));
  const rows = r.rows.map(a => myRow(a, att.get(a.id) ?? []));
  return { rows, pending: rows.filter(x => x.canStart).length };
}

function takeView(x: AttemptDb, questions: TestQuestion[]): MyTestDetailResponse['attempt'] {
  const byId = new Map(questions.map(q => [q.id, q]));
  const qs: TakeQuestion[] = [];
  for (const o of x.question_order) {
    const q = byId.get(o.q);
    if (!q) continue;
    const opts = new Map(q.options.map(op => [op.id, op]));
    qs.push({ id: q.id, kind: q.kind, text: q.text, imageUrl: q.imageUrl, options: o.o.map(id => opts.get(id)).filter(Boolean).map(op => ({ id: op!.id, text: op!.text })) });
  }
  return { id: Number(x.id), startedAt: x.started_at.toISOString(), deadlineAt: x.deadline_at?.toISOString() ?? null, questions: qs, answers: x.answers ?? {} };
}

async function versionQuestions(versionId: string): Promise<TestQuestion[]> {
  const r = await systemDb().query<{ questions: TestQuestion[] }>(`SELECT questions FROM tasker_test_versions WHERE id = $1`, [versionId]);
  return r.rows[0]?.questions ?? [];
}

export async function myTestDetail(session: SessionUser, id: number): Promise<MyTestDetailResponse> {
  await finalizeExpired();
  const a = await loadAssignment(id);
  ownAssignment(session, a);
  const attempts = (await loadAttempts([a.id])).get(a.id) ?? [];
  const s = stateOf(a, attempts);
  let attempt: MyTestDetailResponse['attempt'] = null;
  if (s.open) attempt = takeView(s.open, await versionQuestions(s.open.version_id));
  let review: MyTestDetailResponse['review'] = null;
  if (!s.open && s.last) {
    const wrong = new Set(s.last.wrong_question_ids ?? []);
    const qs = new Map((await versionQuestions(s.last.version_id)).map(q => [q.id, q]));
    review = s.last.question_order.map((o, i) => ({ n: i + 1, text: qs.get(o.q)?.text ?? '', correct: !wrong.has(o.q) }));
  }
  return { row: myRow(a, attempts), attempt, review };
}

export async function startAttempt(session: SessionUser, id: number): Promise<MyTestDetailResponse> {
  const a = await loadAssignment(id);
  ownAssignment(session, a);
  const attempts = (await loadAttempts([a.id])).get(a.id) ?? [];
  const s = stateOf(a, attempts);
  if (s.open) return myTestDetail(session, id);
  if (a.cancelled_at) throw new TestError('Назначение отменено');
  if (s.used >= 1 + a.retakes_allowed) throw new TestError('Попытка уже использована. Пересдачу может разрешить тренер.');
  if (!a.current_version_id) throw new TestError('Тест ещё не опубликован');
  const v = await systemDb().query<{ questions: TestQuestion[]; time_limit_min: number | null; shuffle_questions: boolean; shuffle_options: boolean }>(
    `SELECT questions, time_limit_min, shuffle_questions, shuffle_options FROM tasker_test_versions WHERE id = $1`, [a.current_version_id]);
  const ver = v.rows[0];
  const qs = ver.shuffle_questions ? shuffle(ver.questions) : ver.questions;
  const order = qs.map(q => ({ q: q.id, o: (ver.shuffle_options ? shuffle(q.options) : q.options).map(o => o.id) }));
  await systemDb().query(
    `INSERT INTO tasker_test_attempts (assignment_id, version_id, manager_bitrix_user_id, deadline_at, question_order)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(mins => $4::int) END, $5)
     ON CONFLICT DO NOTHING`,
    [a.id, a.current_version_id, a.manager_bitrix_user_id, ver.time_limit_min, JSON.stringify(order)]);
  return myTestDetail(session, id);
}

function cleanAnswers(raw: unknown, order: { q: string; o: string[] }[], questions: TestQuestion[]): Record<string, string[]> {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kinds = new Map(questions.map(q => [q.id, q.kind]));
  const out: Record<string, string[]> = {};
  for (const o of order) {
    const v = b[o.q];
    if (!Array.isArray(v)) continue;
    const allowed = new Set(o.o);
    let ids = [...new Set(v.map(String).filter(x => allowed.has(x)))];
    if (kinds.get(o.q) === 'single') ids = ids.slice(0, 1);
    if (ids.length) out[o.q] = ids;
  }
  return out;
}

/** Сохранить ответы (автосохранение) и, если submit, — закрыть попытку и посчитать балл. */
export async function saveAnswers(session: SessionUser, id: number, raw: unknown, submit: boolean): Promise<MyTestDetailResponse> {
  const a = await loadAssignment(id);
  ownAssignment(session, a);
  const attempts = (await loadAttempts([a.id])).get(a.id) ?? [];
  const open = attempts.find(x => !x.submitted_at);
  if (!open) throw new TestError('Нет начатой попытки — возможно, время вышло и тест уже засчитан');
  const late = open.deadline_at && open.deadline_at.getTime() + GRACE_MS < Date.now();
  if (!late) {
    const answers = cleanAnswers(raw, open.question_order, await versionQuestions(open.version_id));
    await systemDb().query(`UPDATE tasker_test_attempts SET answers = $2 WHERE id = $1 AND submitted_at IS NULL`, [open.id, JSON.stringify(answers)]);
  }
  if (submit || late) await scoreAndClose(open.id, !!late);
  return myTestDetail(session, id);
}

// ── Результаты ─────────────────────────────────────────────────────────────

async function assignmentRows(actor: TestActor, where: string, args: unknown[]): Promise<{ rows: TestAssignmentRow[]; attempts: Map<string, AttemptDb[]> }> {
  await finalizeExpired();
  const r = await systemDb().query<AssignmentDb>(`${ASSIGNMENT_SELECT} WHERE ${where} ORDER BY a.assigned_at DESC LIMIT 2000`, args);
  const visible = r.rows.filter(a => canTouch(actor, a.manager_bitrix_user_id));
  const [att, dir] = await Promise.all([loadAttempts(visible.map(a => a.id)), getEmployeeDirectory()]);
  const rows = visible.map((a): TestAssignmentRow => {
    const list = att.get(a.id) ?? [];
    const s = stateOf(a, list);
    const mid = Number(a.manager_bitrix_user_id);
    return {
      id: Number(a.id), testId: Number(a.test_id), testTitle: a.title,
      manager: { id: mid, name: dir.get(mid)?.name ?? `Сотрудник #${mid}` },
      departmentName: dir.get(mid)?.departmentName ?? null,
      source: a.source, trainingEventId: a.training_event_id ? Number(a.training_event_id) : null, trainingTitle: a.training_title,
      assignedBy: a.assigned_by_name, assignedAt: a.assigned_at.toISOString(), dueAt: a.due_at.toISOString(),
      retakesAllowed: a.retakes_allowed, state: s.state, attempts: list.map(attemptResult),
      last: s.last ? attemptResult(s.last) : null,
      canRetake: actor.canManage && !a.cancelled_at && !s.open && s.used >= 1 + a.retakes_allowed,
    };
  });
  return { rows, attempts: att };
}

export async function testResults(actor: TestActor, testId: number): Promise<TestResultsResponse> {
  if (!actor.canAssign) throw new TestError('Результаты видят тренер и руководители', 403);
  const t = await loadTestRow(testId);
  const { rows, attempts } = await assignmentRows(actor, 'a.test_id = $1', [testId]);
  // Самые трудные — по последней сданной попытке каждого, тексты — из всех версий, что встречались.
  const versionIds = new Set<string>();
  const lasts: AttemptDb[] = [];
  for (const r of rows) {
    if (r.state === 'cancelled') continue;
    const list = (attempts.get(String(r.id)) ?? []).filter(x => x.submitted_at);
    const l = list[list.length - 1];
    if (l) { lasts.push(l); versionIds.add(l.version_id); }
  }
  const texts = new Map<string, string>();
  if (versionIds.size) {
    const v = await systemDb().query<{ questions: TestQuestion[] }>(`SELECT questions FROM tasker_test_versions WHERE id = ANY($1::bigint[]) ORDER BY version`, [[...versionIds]]);
    for (const row of v.rows) for (const q of row.questions) texts.set(q.id, q.text);
  }
  const stat = new Map<string, TestQuestionStat>();
  for (const l of lasts) {
    const wrong = new Set(l.wrong_question_ids ?? []);
    for (const o of l.question_order) {
      const s = stat.get(o.q) ?? { questionId: o.q, text: texts.get(o.q) ?? '', answered: 0, wrong: 0 };
      s.answered++;
      if (wrong.has(o.q)) s.wrong++;
      stat.set(o.q, s);
    }
  }
  const hardest = [...stat.values()].filter(s => s.wrong > 0).sort((a, b) => b.wrong / b.answered - a.wrong / a.answered || b.wrong - a.wrong).slice(0, 10);
  const agg = await testAggregates(actor, [t.id]);
  return { test: toSummary(t, agg.get(t.id)), rows, hardest, scope: actor.canManage || actor.scope.kind === 'all' ? 'all' : 'own' };
}

/** Тесты менеджера (карточка менеджера, блок «Задачи и обучения»). */
export async function managerTests(actor: TestActor, managerId: string): Promise<TestAssignmentRow[]> {
  const self = actor.session.bitrixUserId && String(actor.session.bitrixUserId) === managerId;
  if (!self && !canTouch(actor, managerId)) throw new TestError('Нет доступа к менеджеру', 403);
  const a = self ? { ...actor, canManage: true } : actor; // свои — видно без среза
  return (await assignmentRows(a, 'a.manager_bitrix_user_id = $1 AND a.cancelled_at IS NULL', [managerId])).rows
    .map(r => ({ ...r, canRetake: actor.canManage && r.canRetake }));
}

// ── Обучения ───────────────────────────────────────────────────────────────

interface LinkRow { event_id: string; test_id: string; title: string; after_days: number; due_days: number }
const linkOf = (l: LinkRow): TrainingTestLink => ({
  eventId: Number(l.event_id), testId: Number(l.test_id), testTitle: l.title, afterDays: l.after_days, dueDays: l.due_days,
});

async function statsForEvents(actor: TestActor, eventIds: number[]): Promise<Map<number, TrainingTestStats & { testTitles: string[] }>> {
  const out = new Map<number, TrainingTestStats & { testTitles: string[] }>();
  if (!eventIds.length) return out;
  const db = systemDb();
  const [links, rows] = await Promise.all([
    db.query<LinkRow>(`SELECT l.event_id, l.test_id, t.title, l.after_days, l.due_days FROM tasker_training_event_tests l
                        JOIN tasker_tests t ON t.id = l.test_id WHERE l.event_id = ANY($1::bigint[])`, [eventIds]),
    db.query<{ training_event_id: string; manager_bitrix_user_id: string; title: string; score: string | null; passed: boolean | null; done: boolean }>(
      `SELECT a.training_event_id, a.manager_bitrix_user_id, t.title, l.score_percent AS score, l.passed, l.id IS NOT NULL AS done
         FROM tasker_test_assignments a
         JOIN tasker_tests t ON t.id = a.test_id
         LEFT JOIN LATERAL (SELECT x.id, x.score_percent, x.passed FROM tasker_test_attempts x
                             WHERE x.assignment_id = a.id AND x.submitted_at IS NOT NULL ORDER BY x.submitted_at DESC LIMIT 1) l ON true
        WHERE a.training_event_id = ANY($1::bigint[]) AND a.cancelled_at IS NULL`, [eventIds]),
  ]);
  const get = (id: number) => {
    let s = out.get(id);
    if (!s) { s = { eventId: id, link: null, assigned: 0, completed: 0, passed: 0, avgScore: null, testTitles: [] }; out.set(id, s); }
    return s;
  };
  for (const l of links.rows) get(Number(l.event_id)).link = linkOf(l);
  const sums = new Map<number, number>();
  for (const r of rows.rows) {
    if (!canTouch(actor, r.manager_bitrix_user_id)) continue;
    const id = Number(r.training_event_id);
    const s = get(id);
    if (!s.testTitles.includes(r.title)) s.testTitles.push(r.title);
    s.assigned++;
    if (r.done) { s.completed++; if (r.passed) s.passed++; sums.set(id, (sums.get(id) ?? 0) + Number(r.score ?? 0)); }
  }
  for (const [id, sum] of sums) { const s = out.get(id)!; s.avgScore = s.completed ? Math.round((sum / s.completed) * 10) / 10 : null; }
  return out;
}

export async function trainingTestStats(actor: TestActor, eventIds: number[]): Promise<TrainingTestStats[]> {
  const m = await statsForEvents(actor, eventIds.slice(0, 200));
  return eventIds.map(id => {
    const s = m.get(id);
    return s ? { eventId: s.eventId, link: s.link, assigned: s.assigned, completed: s.completed, passed: s.passed, avgScore: s.avgScore }
      : { eventId: id, link: null, assigned: 0, completed: 0, passed: 0, avgScore: null };
  });
}

/** Обучения за период, по которым есть тест (вкладка «Эффективность»). */
export async function trainingTestPeriod(actor: TestActor, from: string, to: string): Promise<TrainingTestPeriodRow[]> {
  const ev = await systemDb().query<{ id: string; title: string; start_at: Date }>(
    `SELECT e.id, e.title, e.start_at FROM tasker_training_events e
      WHERE e.cancelled_at IS NULL AND e.start_at >= $1::date AND e.start_at < ($2::date + 1)
        AND (EXISTS (SELECT 1 FROM tasker_test_assignments a WHERE a.training_event_id = e.id AND a.cancelled_at IS NULL)
             OR EXISTS (SELECT 1 FROM tasker_training_event_tests l WHERE l.event_id = e.id))
      ORDER BY e.start_at DESC LIMIT 200`, [from, to]);
  const m = await statsForEvents(actor, ev.rows.map(r => Number(r.id)));
  return ev.rows.map(r => {
    const s = m.get(Number(r.id)) ?? { eventId: Number(r.id), link: null, assigned: 0, completed: 0, passed: 0, avgScore: null, testTitles: [] };
    const titles = s.testTitles.length ? s.testTitles : s.link ? [s.link.testTitle] : [];
    return { ...s, testTitles: titles, title: r.title, startsAt: r.start_at.toISOString() };
  });
}

export async function setTrainingTest(actor: TestActor, eventId: number, raw: unknown): Promise<TrainingTestStats> {
  if (!actor.canManage) throw new TestError('Тест к обучению назначает тренер', 403);
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const db = systemDb();
  const ev = await db.query(`SELECT 1 FROM tasker_training_events WHERE id = $1`, [eventId]);
  if (!ev.rowCount) throw new TestError('Обучение не найдено', 404);
  if (b.testId == null || b.testId === '') {
    await db.query(`DELETE FROM tasker_training_event_tests WHERE event_id = $1`, [eventId]);
  } else {
    const testId = Number(b.testId);
    if (!Number.isInteger(testId)) throw new TestError('Некорректный тест');
    await publishedTest(testId);
    const after = b.afterDays == null || b.afterDays === '' ? 7 : Number(b.afterDays);
    if (!Number.isInteger(after) || after < 0 || after > 60) throw new TestError('«Через сколько дней» — от 0 до 60');
    const due = cleanDueDays(b.dueDays);
    await db.query(
      `INSERT INTO tasker_training_event_tests (event_id, test_id, after_days, due_days, set_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO UPDATE SET test_id = EXCLUDED.test_id, after_days = EXCLUDED.after_days,
         due_days = EXCLUDED.due_days, set_by = EXCLUDED.set_by, updated_at = now()`,
      [eventId, testId, after, due, actor.session.id]);
  }
  return (await trainingTestStats(actor, [eventId]))[0];
}

/** «Назначить сейчас» из карточки обучения — всем отмеченным «был», не дожидаясь N дней. */
export async function assignTrainingNow(actor: TestActor, eventId: number): Promise<TestAssignResponse> {
  if (!actor.canManage) throw new TestError('Назначает тренер', 403);
  const l = await systemDb().query<LinkRow>(
    `SELECT l.event_id, l.test_id, t.title, l.after_days, l.due_days FROM tasker_training_event_tests l
       JOIN tasker_tests t ON t.id = l.test_id WHERE l.event_id = $1`, [eventId]);
  if (!l.rows[0]) throw new TestError('Сначала выберите тест для обучения');
  const res = await assignForLink(l.rows[0], actor.session.id);
  if (!res.created && !res.skipped) throw new TestError('Нет отмеченных «был» — отметьте посещаемость');
  return res;
}

async function assignForLink(l: LinkRow, by: string | null): Promise<TestAssignResponse> {
  const att = await systemDb().query<{ manager_bitrix_user_id: string }>(
    `SELECT x.manager_bitrix_user_id FROM tasker_training_enrollments x
      WHERE x.event_id = $1 AND x.attended IS TRUE
        AND NOT EXISTS (SELECT 1 FROM tasker_test_assignments a
                         WHERE a.test_id = $2 AND a.manager_bitrix_user_id = x.manager_bitrix_user_id AND a.training_event_id = $1)`,
    [l.event_id, l.test_id]);
  const due = dueAtDays(l.due_days);
  return insertAssignments(Number(l.test_id),
    att.rows.map(r => ({ managerId: r.manager_bitrix_user_id, trainingEventId: Number(l.event_id), dueAt: due })), by, 'training');
}

let lastTick = 0;
const TICK_EVERY_MS = 10 * 60_000;

/**
 * Тик тестов внутри job «tasker»: раз в 10 минут — авто-назначение по обучениям (занятие + after_days наступило,
 * менеджер отмечен «был», назначения по этому обучению ещё не было; окно 60 дней — поздняя отметка посещаемости
 * тоже подхватится) и закрытие попыток с истёкшим временем. Таблиц 300 нет — молча.
 */
export async function testsTick(): Promise<{ assigned: number; closed: number }> {
  if (Date.now() - lastTick < TICK_EVERY_MS) return { assigned: 0, closed: 0 };
  lastTick = Date.now();
  try {
    const closed = await finalizeExpired();
    const due = await systemDb().query<LinkRow>(
      `SELECT l.event_id, l.test_id, t.title, l.after_days, l.due_days
         FROM tasker_training_event_tests l
         JOIN tasker_training_events e ON e.id = l.event_id AND e.cancelled_at IS NULL
         JOIN tasker_tests t ON t.id = l.test_id AND t.status = 'published'
        WHERE e.start_at + make_interval(days => l.after_days) <= now()
          AND e.start_at > now() - interval '60 days'`);
    let assigned = 0;
    for (const l of due.rows) assigned += (await assignForLink(l, null)).created;
    return { assigned, closed };
  } catch (e) {
    if (!['42P01', '42703'].includes((e as { code?: string })?.code ?? '')) console.error('[tasker/tests tick]', e instanceof Error ? e.message : e);
    return { assigned: 0, closed: 0 };
  }
}
