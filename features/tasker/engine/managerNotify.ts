// Уведомления менеджеру о работе с ним (собрание 26.11, ТЗ tz/2026-11-26_tasker.md п.2; миграция 302).
// «На менеджера задачи не ставятся» — ему приходит только сообщение бота «Аналитик»: что, когда (с–по), кто ведёт,
// по какой метрике, где. Колокольчик менеджеры пропускают — поэтому именно бот.
//
// Работа = задача «Практика» со временем (без занятия тренера) или запись менеджера на занятие тренера
// (так приходят «Теория» и «Записать на обучение»). Вместо того чтобы звать бота из каждого места, где меняется
// время (создание, перенос задачи/сессии, правка/отмена занятия, отписка, отмена задачи), сверяем раз в минуту
// (тик Задачника) список будущих работ с tasker_work_notices — «что мы уже сообщили» — и шлём разницу:
//   новая работа → «назначено»; другое время → «перенесено»; другая тема занятия → «тема изменилась»;
//   работа пропала → «отменено»; до начала ≤ N минут → напоминание (N — tasker_settings.manager_notify).
// Сразу после постановки create.ts зовёт сверку по своим менеджерам, чтобы не ждать минуту.
// Первый запуск после выкатки — «тихий»: существующие будущие работы записываются без сообщений (не спамим
// старым), дальше работают только изменения и напоминания.
// Канал бота — tasker_manager_notify (выключен → сообщения не уходят, но состояние ведётся: включение не
// вызовет лавину старых «назначено»).
import 'server-only';
import { systemDb } from '@/lib/db/clients';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import { loadMetricDefs } from './config';
import { fmtWhen } from './when';

export const REMIND_OPTIONS = [15, 30, 60, 1440] as const;
export const DEFAULT_REMIND_MIN = 30;
const CHANNEL = 'tasker_manager_notify' as const;

interface Work {
  key: string; managerId: string; start: string; end: string; topic: string; lead: string | null;
  kind: 'practice' | 'training'; metrics: string; place: string | null; entityId: string;
}

interface NoticeRow {
  work_key: string; manager_bitrix_id: string; start_at: Date; end_at: Date; topic: string; lead_name: string | null;
  reminded_at: Date | null; gone_at: Date | null;
}

const ignoreMissing = <T,>(fallback: T) => (e: unknown): T => {
  const code = (e as { code?: string })?.code;
  if (code === '42P01' || code === '42703') return fallback;
  throw e;
};

export async function loadRemindMinutes(): Promise<number> {
  const r = await systemDb().query<{ value: { remind_minutes?: unknown } | null }>(`SELECT value FROM tasker_settings WHERE key = 'manager_notify'`)
    .catch(ignoreMissing({ rows: [] as { value: { remind_minutes?: unknown } | null }[] }));
  const n = Number(r.rows[0]?.value?.remind_minutes);
  return (REMIND_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_REMIND_MIN;
}

export async function saveRemindMinutes(minutes: number): Promise<number> {
  if (!(REMIND_OPTIONS as readonly number[]).includes(minutes)) throw new Error('Напоминание — за 15 минут, 30 минут, час или день');
  await systemDb().query(
    `INSERT INTO tasker_settings (key, value, updated_at) VALUES ('manager_notify', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = tasker_settings.value || EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ remind_minutes: minutes })]);
  return minutes;
}

export const remindLabel = (m: number) => (m === 1440 ? 'за день' : m === 60 ? 'за час' : `за ${m} минут`);

/** Будущие работы менеджеров (managerIds — только эти). */
async function currentWorks(managerIds: string[] | null): Promise<Work[]> {
  const db = systemDb();
  const [labels, dir] = await Promise.all([
    loadMetricDefs().then(ms => new Map(ms.map(m => [m.id, m.label]))).catch(() => new Map<string, string>()),
    getEmployeeDirectory(),
  ]);
  const out: Work[] = [];
  const tasks = await db.query<{ id: string; manager_bitrix_id: string; slot_start: Date; slot_end: Date | null; duration_min: number; executor_name: string | null; metric_id: string }>(
    `SELECT t.id, t.manager_bitrix_id, t.slot_start, t.slot_end, t.duration_min, t.executor_name, t.metric_id
       FROM tasker_tasks t
      WHERE COALESCE(t.kind, 'practice') = 'practice' AND t.training_event_id IS NULL AND t.slot_start > now()
        AND t.cancelled_at IS NULL AND COALESCE(t.bitrix_status, 0) <> 7
        AND ($1::text[] IS NULL OR t.manager_bitrix_id = ANY($1::text[]))`, [managerIds]);
  for (const t of tasks.rows) {
    const start = t.slot_start.getTime();
    const end = t.slot_end ? t.slot_end.getTime() : start + t.duration_min * 60_000;
    const metric = labels.get(t.metric_id) ?? t.metric_id;
    out.push({
      key: `task:${t.id}`, managerId: t.manager_bitrix_id, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      topic: metric, lead: t.executor_name, kind: 'practice', metrics: metric, place: null, entityId: t.id,
    });
  }
  const enr = await db.query<{ event_id: string; manager: string; start_at: Date; duration_min: number; title: string; place: string | null; trainer: string | null; metric_ids: string[] | null; task_metric_id: string | null }>(
    `SELECT x.event_id, x.manager_bitrix_user_id AS manager, e.start_at, e.duration_min, e.title, e.place,
            e.trainer_bitrix_user_id AS trainer, e.metric_ids, x.task_metric_id
       FROM tasker_training_enrollments x JOIN tasker_training_events e ON e.id = x.event_id
      WHERE e.cancelled_at IS NULL AND e.start_at > now()
        AND ($1::text[] IS NULL OR x.manager_bitrix_user_id = ANY($1::text[]))`, [managerIds]).catch(ignoreMissing({ rows: [] as never[] }));
  for (const x of enr.rows) {
    const start = x.start_at.getTime();
    const reason = x.task_metric_id ? [x.task_metric_id] : (x.metric_ids ?? []);
    out.push({
      key: `enr:${x.event_id}:${x.manager}`, managerId: x.manager, start: new Date(start).toISOString(),
      end: new Date(start + x.duration_min * 60_000).toISOString(), topic: x.title,
      lead: x.trainer ? dir.get(Number(x.trainer))?.name ?? null : null, kind: 'training',
      metrics: reason.map(id => labels.get(id) ?? id).join(', '), place: x.place, entityId: x.event_id,
    });
  }
  return out;
}

// ── Тексты (BB-коды Битрикса: B/I/COLOR/URL; LIST/QUOTE/TABLE не работают) ──

function body(w: Work): string[] {
  const lines = [`🗓 [B]${fmtWhen(w.start, w.end)}[/B] (МСК)`];
  if (w.kind === 'practice') {
    if (w.lead) lines.push(`Ведёт: ${w.lead} (РОП)`);
    lines.push(`По показателю: «${w.metrics}»`);
  } else {
    lines.push(`Тема: «${w.topic}»`);
    if (w.lead) lines.push(`Ведёт: тренер ${w.lead}`);
    if (w.metrics && w.metrics !== w.topic) lines.push(`Повод: ${w.metrics}`);
  }
  if (w.place) lines.push(`Где: ${w.place}`);
  return lines;
}

const what = (w: Work) => (w.kind === 'practice' ? 'разбор с РОПом' : 'занятие с тренером');

export function workMessage(type: 'new' | 'moved' | 'topic' | 'remind' | 'gone' | 'approved', w: Work, prev?: { start: string; end: string; topic: string }, remindMin?: number): string {
  switch (type) {
    case 'new': return [`[B]С вами запланирован ${what(w)}[/B]`, ...body(w)].join('\n');
    case 'moved': return [`[B]Перенос: ${what(w)}[/B]`, prev ? `[COLOR=#999999]Было: ${fmtWhen(prev.start, prev.end)}[/COLOR]` : '', ...body(w)].filter(Boolean).join('\n');
    case 'topic': return [`[B]Новая тема занятия[/B]`, prev ? `[COLOR=#999999]Было: «${prev.topic}»[/COLOR]` : '', ...body(w)].filter(Boolean).join('\n');
    case 'remind': return [`⏰ [B]Напоминание: ${remindMin === 1440 ? 'завтра' : `через ${remindMin && remindMin >= 60 ? 'час' : `${remindMin ?? DEFAULT_REMIND_MIN} минут`}`} ${what(w)}[/B]`, ...body(w)].join('\n');
    case 'gone': return [`[B]Отменено: ${what(w)}[/B]`, ...body(w).slice(0, 1), w.kind === 'practice' ? `По показателю: «${w.metrics}»` : `Тема: «${w.topic}»`].join('\n');
    case 'approved': return [`[B]Занятие утверждено[/B] — ждём вас`, ...body(w)].join('\n');
  }
}

async function send(w: Work, type: Parameters<typeof workMessage>[0], text: string): Promise<void> {
  await sendBitrixBotMessage(w.managerId, text, undefined, CHANNEL,
    { kind: `tasker_work_${type}`, entityType: w.kind === 'practice' ? 'tasker_task' : 'tasker_training_event', entityId: w.entityId })
    .catch(e => console.warn('[tasker/notify]', w.key, type, e instanceof Error ? e.message : e));
}

const workOfRow = (r: NoticeRow, managerId: string): Work => ({
  key: r.work_key, managerId, start: r.start_at.toISOString(), end: r.end_at.toISOString(), topic: r.topic, lead: r.lead_name,
  kind: r.work_key.startsWith('task:') ? 'practice' : 'training', metrics: r.topic, place: null, entityId: r.work_key.split(':')[1] ?? '',
});

/** Сверка работ с журналом и отправка разницы. Один исполнитель (advisory lock); занят — пропускаем, догонит тик. */
export async function reconcileWorkNotices(managerIds: string[] | null = null): Promise<{ sent: number } | null> {
  const db = systemDb();
  const client = await db.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('tasker_work_notices')) AS ok`);
    if (!lock.rows[0]?.ok) return null;
    try {
      return await reconcileLocked(managerIds);
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('tasker_work_notices'))`).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function reconcileLocked(managerIds: string[] | null): Promise<{ sent: number }> {
  const db = systemDb();
  const seeded = await db.query<{ value: unknown }>(`SELECT value FROM tasker_settings WHERE key = 'manager_notify_seeded'`);
  const works = await currentWorks(seeded.rows.length ? managerIds : null);
  const upsert = (w: Work, extra: { notified?: boolean; reminded?: boolean | null; silent?: boolean }) => db.query(
    `INSERT INTO tasker_work_notices (work_key, manager_bitrix_id, start_at, end_at, topic, lead_name, notified_at, reminded_at, gone_at, silent, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END, CASE WHEN $8 THEN now() END, NULL, $9, now())
     ON CONFLICT (work_key) DO UPDATE SET manager_bitrix_id = EXCLUDED.manager_bitrix_id, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at,
       topic = EXCLUDED.topic, lead_name = EXCLUDED.lead_name, gone_at = NULL, updated_at = now(),
       notified_at = CASE WHEN $7 THEN now() ELSE tasker_work_notices.notified_at END,
       reminded_at = CASE WHEN $8 IS NULL THEN tasker_work_notices.reminded_at WHEN $8 THEN now() ELSE NULL END`,
    [w.key, w.managerId, w.start, w.end, w.topic, w.lead, !!extra.notified, extra.reminded === undefined ? null : extra.reminded, !!extra.silent]);

  if (!seeded.rows.length) {
    // Первый запуск: всё существующее — тихо, без сообщений.
    for (const w of works) await upsert(w, { notified: true, silent: true });
    await db.query(`INSERT INTO tasker_settings (key, value) VALUES ('manager_notify_seeded', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`);
    console.info(`[tasker/notify] первый запуск: записано ${works.length} работ без сообщений`);
    return { sent: 0 };
  }

  const remindMin = await loadRemindMinutes();
  const now = Date.now();
  const keys = works.map(w => w.key);
  const rows = await db.query<NoticeRow>(
    `SELECT work_key, manager_bitrix_id, start_at, end_at, topic, lead_name, reminded_at, gone_at FROM tasker_work_notices
      WHERE work_key = ANY($1::text[])
         OR (gone_at IS NULL AND start_at > now() AND ($2::text[] IS NULL OR manager_bitrix_id = ANY($2::text[])))`,
    [keys, managerIds]);
  const byKey = new Map(rows.rows.map(r => [r.work_key, r]));
  let sent = 0;

  for (const w of works) {
    const r = byKey.get(w.key);
    const startMs = Date.parse(w.start);
    const dueRemind = startMs - now <= remindMin * 60_000;
    if (!r || r.gone_at) {
      await send(w, 'new', workMessage('new', w)); sent++;
      // Поставили уже внутри окна напоминания — отдельное «напоминание» не шлём, время и так в сообщении.
      await upsert(w, { notified: true, reminded: dueRemind });
      continue;
    }
    const moved = r.start_at.getTime() !== startMs || r.end_at.getTime() !== Date.parse(w.end);
    if (moved) {
      await send(w, 'moved', workMessage('moved', w, { start: r.start_at.toISOString(), end: r.end_at.toISOString(), topic: r.topic })); sent++;
      await upsert(w, { notified: true, reminded: dueRemind });
      continue;
    }
    if (w.kind === 'training' && r.topic !== w.topic) {
      await send(w, 'topic', workMessage('topic', w, { start: w.start, end: w.end, topic: r.topic })); sent++;
      await upsert(w, {});
    }
    if (!r.reminded_at && dueRemind) {
      await send(w, 'remind', workMessage('remind', w, undefined, remindMin)); sent++;
      await upsert(w, { reminded: true });
    }
  }

  const present = new Set(keys);
  for (const r of rows.rows) {
    if (present.has(r.work_key) || r.gone_at || r.start_at.getTime() <= now) continue;
    const w = workOfRow(r, r.manager_bitrix_id);
    await send(w, 'gone', workMessage('gone', w)); sent++;
    await db.query(`UPDATE tasker_work_notices SET gone_at = now(), updated_at = now() WHERE work_key = $1`, [r.work_key]);
  }
  return { sent };
}

/** Сразу после постановки — по своим менеджерам. Таблицы ещё нет (302 не накачена) — молча. */
export async function notifyManagersNow(managerIds: string[]): Promise<void> {
  if (!managerIds.length) return;
  await reconcileWorkNotices(managerIds).catch(ignoreMissing(null));
}

/** «Утвердить состав и тему» (п.7): всем записанным — тема и время; журнал обновляется, чтобы тик не прислал «тема изменилась». */
export async function sendApprovedNotices(eventId: number): Promise<number> {
  const all = await currentWorks(null);
  const mine = all.filter(w => w.key.startsWith(`enr:${eventId}:`));
  for (const w of mine) {
    await send(w, 'approved', workMessage('approved', w));
    await systemDb().query(
      `INSERT INTO tasker_work_notices (work_key, manager_bitrix_id, start_at, end_at, topic, lead_name, notified_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (work_key) DO UPDATE SET start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at, topic = EXCLUDED.topic,
         lead_name = EXCLUDED.lead_name, gone_at = NULL, notified_at = now(), updated_at = now()`,
      [w.key, w.managerId, w.start, w.end, w.topic, w.lead]).catch(ignoreMissing(null));
  }
  return mine.length;
}
