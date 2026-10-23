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

interface BxTask { id?: string; status?: string; groupId?: string; ufCrmTask?: string[] | null; title?: string }

/** Задача — этого проекта, привязана к этой сделке и ждёт контроля. */
export async function checkTask(taskId: number, dealId: number): Promise<BxTask> {
  const r = await read<{ task?: BxTask }>('tasks.task.get', { taskId, select: ['ID', 'STATUS', 'GROUP_ID', 'UF_CRM_TASK', 'TITLE'] })
    .catch(e => { throw new TaskReviewError(`Битрикс не отдал задачу ${taskId}: ${e instanceof Error ? e.message : e}`); });
  const t = r?.task;
  if (!t?.id) throw new TaskReviewError(`Задача ${taskId} не найдена в Битриксе`);
  if (Number(t.groupId) !== REPEAT_PROJECT_GROUP_ID) throw new TaskReviewError('Задача не из проекта «Повторные продажи»');
  if (!(t.ufCrmTask ?? []).includes(`D_${dealId}`)) throw new TaskReviewError('Задача привязана к другой сделке — обновите доску');
  if (String(t.status) !== '4') throw new TaskReviewError('Задача уже не ждёт приёмки (её приняли или вернули) — обновите доску');
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
