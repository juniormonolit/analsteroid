// Приёмка задачи прямо из канбана (владелец 22.10: «чтобы из канбана можно было принимать задачи и
// сразу браковать сделки. 3 кнопки: принять задачу и закрыть сделку (и выбор стадии), принять задачу,
// отправить на доработку»). Задача проекта 118 в статусе 4 «ждёт контроля»:
//   accept — tasks.task.approve (задача завершена);
//   return — tasks.task.disapprove (обратно в работу) + новый срок, если задан;
//   сделка задачи уже закрыта (отказ или отгружена) — «Откатить и создать задачу» (23.10, ниже).
// Вебхук принадлежит админу портала (2098) — в истории задачи действие будет от него, поэтому
// решение и комментарий РОПа всегда пишутся комментарием задачи ОТ ИМЕНИ нажавшего (как первый
// комментарий при постановке, postToTaskChat). «Закрыть сделку» — тот же путь, что «Сразу в брак»
// (route.ts: markBrakNow + closeDealAsLost).
import { DealCreateError, postToTaskChat, read, taskWebhook, writeOnce } from './createDeal';
import { REPEAT_PROJECT_GROUP_ID } from './config';

export class TaskReviewError extends Error {}

interface BxTask { id?: string; status?: string; groupId?: string; ufCrmTask?: string[] | null; title?: string; closedBy?: string | null; closedDate?: string | null }

// Состояние задачи по Битриксу, которое мы и так узнаём при приёмке (09.11: копия задач sa.bitrix_task_current
// стоит с 08.10 после смерти сервера 62 — доска показывала «ждёт контроля» у задачи, закрытой в Битриксе).
// Запоминаем в Redis на 30 дней; tasks.ts накладывает поверх копии. Лишних запросов в Битрикс нет.
const STATE_TTL = 30 * 86_400;
export async function rememberTaskStatus(taskId: number, status: number, closedAt: string | null): Promise<void> {
  const { redisReady } = await import('@/lib/cache/redis');
  const r = await redisReady().catch(() => null);
  if (r) await r.set(`repeat:task-status:${taskId}`, JSON.stringify({ status, closedAt, at: new Date().toISOString() }), 'EX', STATE_TTL).catch(() => {});
}
export async function knownTaskStatuses(taskIds: number[]): Promise<Map<number, { status: number; closedAt: string | null; at: string }>> {
  if (!taskIds.length) return new Map();
  const { redisReady } = await import('@/lib/cache/redis');
  const r = await redisReady().catch(() => null);
  if (!r) return new Map();
  const vals = await r.mget(...taskIds.map(id => `repeat:task-status:${id}`)).catch(() => [] as (string | null)[]);
  const out = new Map<number, { status: number; closedAt: string | null; at: string }>();
  vals.forEach((v, i) => { if (v) try { out.set(taskIds[i], JSON.parse(v)); } catch { /* битая запись */ } });
  return out;
}

/** Кто и когда закрыл — для понятной ошибки («закрыла Светлана Небога 09.11 12:00»). */
async function closedText(t: BxTask): Promise<string> {
  const when = t.closedDate ? new Date(t.closedDate).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : null;
  let who: string | null = null;
  if (t.closedBy) {
    const { analyticsDb } = await import('@/lib/db/clients');
    who = (await analyticsDb().query<{ n: string }>(`SELECT manager_name AS n FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1 LIMIT 1`, [String(t.closedBy)])
      .catch(() => ({ rows: [] as { n: string }[] }))).rows[0]?.n ?? `#${t.closedBy}`;
  }
  return [who && `закрыл(а) ${who}`, when].filter(Boolean).join(' ');
}

/** Задача — этого проекта, привязана к этой сделке и ждёт контроля. allowDone — для отката: задачу уже
 *  закрыли в Битриксе руками, это не мешает поставить новую (возвращает status '5'). */
export async function checkTask(taskId: number, dealId: number, opts: { allowDone?: boolean } = {}): Promise<BxTask> {
  const r = await read<{ task?: BxTask }>('tasks.task.get', { taskId, select: ['ID', 'STATUS', 'GROUP_ID', 'UF_CRM_TASK', 'TITLE', 'CLOSED_BY', 'CLOSED_DATE'] })
    .catch(e => { throw new TaskReviewError(`Битрикс не отдал задачу ${taskId}: ${e instanceof Error ? e.message : e}`); });
  const t = r?.task;
  if (!t?.id) throw new TaskReviewError(`Задача ${taskId} не найдена в Битриксе`);
  if (Number(t.groupId) !== REPEAT_PROJECT_GROUP_ID) throw new TaskReviewError('Задача не из проекта «Повторные продажи»');
  if (!(t.ufCrmTask ?? []).includes(`D_${dealId}`)) throw new TaskReviewError('Задача привязана к другой сделке — обновите доску');
  await rememberTaskStatus(taskId, Number(t.status), t.closedDate ?? null);
  if (String(t.status) === '5' && opts.allowDone) return t;
  if (String(t.status) === '5') {
    const ct = await closedText(t);
    throw new TaskReviewError(`Задача уже закрыта в Битриксе${ct ? ` — ${ct}` : ''}. Доска об этом не знала: копия задач Битрикса не обновляется с 08.10 (после переезда сервера). Карточка обновится сама.`);
  }
  if (String(t.status) !== '4') throw new TaskReviewError('Задача уже не ждёт приёмки (её вернули в работу) — обновите доску');
  return t;
}

const note = async (taskId: number, authorId: string | null, text: string, files: number[] = []) => {
  if (!authorId) return false;
  return postToTaskChat(taskId, authorId, text, files).catch(e => {
    console.warn(`[repeat-kanban] комментарий приёмки в задачу ${taskId} не ушёл:`, e instanceof Error ? e.message : e);
    return false;
  });
};

const wrap = async <T,>(fn: () => Promise<T>) => {
  try { return await fn(); } catch (e) {
    if (e instanceof DealCreateError) throw new TaskReviewError(e.message);
    throw e;
  }
};

/** Принять задачу. Комментарий РОПа (если есть) — в задачу от его имени. */
export async function acceptTask(input: { taskId: number; dealId: number; comment: string | null; authorId: string | null; closing?: string | null; files?: number[] }): Promise<{ commented: boolean }> {
  await checkTask(input.taskId, input.dealId);
  await wrap(() => writeOnce(taskWebhook(), 'tasks.task.approve', { taskId: input.taskId }));
  const parts = ['Задача принята в канбане повторных (Монолитика)'];
  if (input.closing) parts.push(`сделка закрыта: ${input.closing}`);
  const text = `${parts.join('; ')}${input.comment?.trim() ? `.\n${input.comment.trim()}` : ''}`;
  return { commented: await note(input.taskId, input.authorId, text, input.files) };
}

/** На доработку: комментарий обязателен (что доделать); новый срок — если старый прошёл или РОП задал. */
export async function returnTask(input: { taskId: number; dealId: number; comment: string; authorId: string | null; deadline: string | null; files?: number[] }): Promise<{ commented: boolean }> {
  const comment = input.comment.trim();
  if (comment.length < 3) throw new TaskReviewError('Напишите, что доделать');
  if (input.deadline && new Date(input.deadline).getTime() < Date.now()) throw new TaskReviewError('Новый срок уже прошёл — выберите позже');
  await checkTask(input.taskId, input.dealId);
  await wrap(() => writeOnce(taskWebhook(), 'tasks.task.disapprove', { taskId: input.taskId }));
  if (input.deadline) {
    await wrap(() => writeOnce(taskWebhook(), 'tasks.task.update', { taskId: input.taskId, fields: { DEADLINE: input.deadline } }))
      .catch(e => console.warn(`[repeat-kanban] новый срок задачи ${input.taskId}:`, e instanceof Error ? e.message : e));
  }
  return { commented: await note(input.taskId, input.authorId, `Возвращено на доработку из канбана повторных (Монолитика):\n${comment}`, input.files) };
}

// ── «Откатить и создать задачу» (владелец 23.10, два живых случая). Задача ждёт приёмки, а её сделка
// уже закрыта: 245809 — в отказе (вернули задачу, сделка осталась в отказе), 247490 — отгружена
// (вернули — менеджер «дорабатывает» в закрытой успешной сделке). Вернуть такую задачу нельзя:
// ставим новую тем же путём, что «Поставить задачу» (createRepeatTask: последняя повторная в отказе —
// откатываем её на первую стадию, отгружена — новая сделка), старую принимаем со ссылкой на новую.

export type TaskDealState = 'open' | 'lost' | 'won';

/** Стадия сделки задачи по Битриксу (а не по копии sa — она отстаёт). */
export async function taskDealState(dealId: number): Promise<TaskDealState> {
  const d = await read<{ STAGE_SEMANTIC_ID?: string }>('crm.deal.get', { id: dealId })
    .catch(e => { throw new TaskReviewError(`Битрикс не отдал сделку #${dealId}: ${e instanceof Error ? e.message : e}`); });
  return d?.STAGE_SEMANTIC_ID === 'F' ? 'lost' : d?.STAGE_SEMANTIC_ID === 'S' ? 'won' : 'open';
}

/** Старая задача после отката: принять, в чат — куда ушла работа. Не роняет действие — новая уже стоит. */
export async function closeReplacedTask(input: { taskId: number; authorId: string | null; newTaskId: number; newDealId: number; reopened: boolean }): Promise<boolean> {
  try {
    await writeOnce(taskWebhook(), 'tasks.task.approve', { taskId: input.taskId });
  } catch (e) {
    console.warn(`[repeat-kanban] старая задача ${input.taskId} при откате не закрылась:`, e instanceof Error ? e.message : e);
    return false;
  }
  await note(input.taskId, input.authorId, `Закрыта в канбане повторных (Монолитика): сделка уже была закрыта, вместо этой задачи поставлена новая #${input.newTaskId} в ${input.reopened ? 'сделке' : 'новой сделке'} #${input.newDealId}.`);
  return true;
}

// ── Фоновое обновление статусов (владелец 09.11: «включи», «батчами и максимально вежливо — не дай бог
// Битрикс затроит»). Пока синк задач Битрикса стоит (копия sa.bitrix_task_current — с 08.10), раз в 30 минут
// в рабочее время спрашиваем Битрикс только про НЕЗАКРЫТЫЕ задачи проекта: из копии и поставленные из
// Монолитики. Пачки по 25 (tasks.task.list), пауза 3 с между пачками, ошибка — пропускаем прогон.
// Выключить — убрать repeatTaskStatus из BACKGROUND_JOBS_ALLOW (secrets.env) и перезапустить; удалить
// целиком — когда синк задач восстановят.
const REFRESH_BATCH = 25;
const REFRESH_PAUSE_MS = 3000;

export async function refreshOpenTaskStatuses(): Promise<{ asked: number; got: number; closed: number }> {
  const { analyticsDb, systemDb } = await import('@/lib/db/clients');
  const copy = await analyticsDb().query<{ id: string }>(
    `SELECT task_id::text AS id FROM sa.bitrix_task_current WHERE group_id = $1 AND NOT is_deleted AND coalesce(status, 0) <> 5`,
    [REPEAT_PROJECT_GROUP_ID],
  );
  const ours = await systemDb().query<{ id: string }>(
    `SELECT DISTINCT task_id::text AS id FROM repeat_kanban_events WHERE task_id IS NOT NULL AND ts > now() - interval '60 days'
     UNION SELECT issued_task_id::text FROM repeat_task_queue WHERE issued_task_id IS NOT NULL AND issued_at > now() - interval '60 days'`,
  ).catch(() => ({ rows: [] as { id: string }[] }));
  const all = [...new Set([...copy.rows, ...ours.rows].map(x => Number(x.id)).filter(n => n > 0))];
  const known = await knownTaskStatuses(all);
  const ids = all.filter(id => known.get(id)?.status !== 5); // закрытые уже не спрашиваем
  let got = 0, closed = 0;
  for (let i = 0; i < ids.length; i += REFRESH_BATCH) {
    if (i) await new Promise(r => setTimeout(r, REFRESH_PAUSE_MS));
    const chunk = ids.slice(i, i + REFRESH_BATCH);
    const r = await read<{ tasks?: { id: string; status: string; closedDate?: string | null }[] }>(
      'tasks.task.list', { filter: { ID: chunk }, select: ['ID', 'STATUS', 'CLOSED_DATE'] });
    for (const t of r?.tasks ?? []) {
      got++;
      if (Number(t.status) === 5) closed++;
      await rememberTaskStatus(Number(t.id), Number(t.status), t.closedDate ?? null);
    }
  }
  return { asked: ids.length, got, closed };
}
