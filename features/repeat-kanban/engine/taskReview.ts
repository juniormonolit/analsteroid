// Приёмка задачи прямо из канбана (владелец 22.10: «чтобы из канбана можно было принимать задачи и
// сразу браковать сделки. 3 кнопки: принять задачу и закрыть сделку (и выбор стадии), принять задачу,
// отправить на доработку»). Задача проекта 118 в статусе 4 «ждёт контроля»:
//   accept — tasks.task.approve (задача завершена);
//   return — tasks.task.disapprove (обратно в работу) + новый срок, если задан.
// Вебхук принадлежит админу портала (2098) — в истории задачи действие будет от него, поэтому
// решение и комментарий РОПа всегда пишутся комментарием задачи ОТ ИМЕНИ нажавшего (как первый
// комментарий при постановке, postToTaskChat). «Закрыть сделку» — тот же путь, что «Сразу в брак»
// (route.ts: markBrakNow + closeDealAsLost).
import { DealCreateError, postToTaskChat, read, taskWebhook, writeOnce } from './createDeal';
import { REPEAT_PROJECT_GROUP_ID } from './config';

export class TaskReviewError extends Error {}

interface BxTask { id?: string; status?: string; groupId?: string; ufCrmTask?: string[] | null; title?: string }

/** Задача — этого проекта, привязана к этой сделке и ждёт контроля. */
async function checkTask(taskId: number, dealId: number): Promise<BxTask> {
  const r = await read<{ task?: BxTask }>('tasks.task.get', { taskId, select: ['ID', 'STATUS', 'GROUP_ID', 'UF_CRM_TASK', 'TITLE'] })
    .catch(e => { throw new TaskReviewError(`Битрикс не отдал задачу ${taskId}: ${e instanceof Error ? e.message : e}`); });
  const t = r?.task;
  if (!t?.id) throw new TaskReviewError(`Задача ${taskId} не найдена в Битриксе`);
  if (Number(t.groupId) !== REPEAT_PROJECT_GROUP_ID) throw new TaskReviewError('Задача не из проекта «Повторные продажи»');
  if (!(t.ufCrmTask ?? []).includes(`D_${dealId}`)) throw new TaskReviewError('Задача привязана к другой сделке — обновите доску');
  if (String(t.status) !== '4') throw new TaskReviewError('Задача уже не ждёт приёмки (её приняли или вернули) — обновите доску');
  return t;
}

const note = async (taskId: number, authorId: string | null, text: string) => {
  if (!authorId) return false;
  return postToTaskChat(taskId, authorId, text).catch(e => {
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
export async function acceptTask(input: { taskId: number; dealId: number; comment: string | null; authorId: string | null; closing?: string | null }): Promise<{ commented: boolean }> {
  await checkTask(input.taskId, input.dealId);
  await wrap(() => writeOnce(taskWebhook(), 'tasks.task.approve', { taskId: input.taskId }));
  const parts = ['Задача принята в канбане повторных (Монолитика)'];
  if (input.closing) parts.push(`сделка закрыта: ${input.closing}`);
  const text = `${parts.join('; ')}${input.comment?.trim() ? `.\n${input.comment.trim()}` : ''}`;
  return { commented: await note(input.taskId, input.authorId, text) };
}

/** На доработку: комментарий обязателен (что доделать); новый срок — если старый прошёл или РОП задал. */
export async function returnTask(input: { taskId: number; dealId: number; comment: string; authorId: string | null; deadline: string | null }): Promise<{ commented: boolean }> {
  const comment = input.comment.trim();
  if (comment.length < 3) throw new TaskReviewError('Напишите, что доделать');
  if (input.deadline && new Date(input.deadline).getTime() < Date.now()) throw new TaskReviewError('Новый срок уже прошёл — выберите позже');
  await checkTask(input.taskId, input.dealId);
  await wrap(() => writeOnce(taskWebhook(), 'tasks.task.disapprove', { taskId: input.taskId }));
  if (input.deadline) {
    await wrap(() => writeOnce(taskWebhook(), 'tasks.task.update', { taskId: input.taskId, fields: { DEADLINE: input.deadline } }))
      .catch(e => console.warn(`[repeat-kanban] новый срок задачи ${input.taskId}:`, e instanceof Error ? e.message : e));
  }
  return { commented: await note(input.taskId, input.authorId, `Возвращено на доработку из канбана повторных (Монолитика):\n${comment}`) };
}
