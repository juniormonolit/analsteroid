// Действия канбана больших чеков (BIG_DEALS_KANBAN_SPEC.md, решения владельца 18.11):
// move / reassign / comment / accept / return / complete над ЗАДАЧЕЙ Битрикса из проектов больших сделок.
//
// От чьего имени. Каждое изменение задачи сначала пробуем токеном нажавшего (callAsUser — в истории
// задачи будет РОП), а если у Битрикса нет его токена/прав — вебхуком (владелец вебхука — админ портала
// 2098, у него права на всё). Комментарии — postToTaskChat: вебхук с AUTHOR_ID нажавшего, в чате задачи
// автором виден РОП (как в канбане повторных).
//
// Завершение (колонки AUTO_COMPLETE_COLUMNS и кнопка «Не продано → завершить»). У задач проектов стоит
// «контроль постановщика» (taskControl = Y, сверено на 176570): tasks.task.complete от НЕ-постановщика
// переводит задачу в «ждёт контроля» (4), закрыть её до 5 может только постановщик/админ — tasks.task.approve.
// Поэтому: complete (если ещё не 4) → перечитать статус → не 5 — approve (токен РОПа, отказ — вебхук админа).
// Вызывающий — не постановщик и не исполнитель (РОП-наблюдатель) — complete от его имени Битрикс отклонит,
// callAsUser вернёт undefined и действие уйдёт вебхуком: в истории задачи будет админ, а в чате — комментарий
// «закрыто из канбана» от имени РОПа (кто на самом деле нажал).
//
// Сухой прогон: runBigAction(..., { dryRun: true }) — ничего не пишет, только читает задачу и возвращает
// список REST-вызовов, которые ушли бы (scratchpad-скрипт проверки, без записи в прод-портал).
import { BIG_COLUMNS, BIG_DEALS_GROUP_IDS, AUTO_COMPLETE_COLUMNS, type BigColumnKey } from './config';
import type { BigAction, BigTaskCard } from './types';
import { stageIdForColumn } from './stages';
import { refreshTask } from './load';
import { markColumn } from './stageSince';
import { DealCreateError, postToTaskChat, read, taskWebhook, writeOnce } from '@/features/repeat-kanban/engine/createDeal';
import { callAsUser, UserCallUnsure } from '@/lib/bitrix/userTokens';

export class BigActionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Кто нажал и что ему можно (считает роут из ropScope/scopeManagers). */
export interface BigActor {
  userId: string | null;
  name: string | null;
  /** РОП/директор/админ — может двигать, переназначать, принимать. */
  canManage: boolean;
  /** Bitrix id менеджеров зоны; 'all' — без ограничений (руководство). */
  zone: Set<string> | 'all';
}

export interface BxBigTask {
  id: string;
  title?: string;
  status?: string;
  groupId?: string;
  stageId?: string;
  responsibleId?: string;
  createdBy?: string;
  auditors?: string[];
  accomplices?: string[];
  taskControl?: string;
  ufCrmTask?: string[] | null;
}

export interface PlannedCall { as: 'user→webhook' | 'webhook' | 'chat-comment'; method: string; params: Record<string, unknown>; note?: string }
export interface RunOpts { dryRun?: boolean }
export interface RunResult { card: BigTaskCard | null; calls: PlannedCall[]; warnings: string[] }

const TASK_SELECT = ['ID', 'TITLE', 'STATUS', 'GROUP_ID', 'STAGE_ID', 'RESPONSIBLE_ID', 'CREATED_BY', 'AUDITORS', 'ACCOMPLICES', 'TASK_CONTROL', 'UF_CRM_TASK'];
const columnTitle = (k: BigColumnKey) => BIG_COLUMNS.find(c => c.key === k)?.title ?? k;
const COLUMN_KEYS = new Set<string>(BIG_COLUMNS.map(c => c.key));

/** Ошибку Битрикса — человеческим текстом. */
function humanBx(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/ACCESS_DENIED|access denied|недостаточно прав/i.test(m)) return 'Битрикс не дал прав на это действие с задачей';
  if (/not found|не найден/i.test(m)) return 'Задача не найдена в Битриксе — возможно, удалена';
  if (/timeout|aborted|fetch failed/i.test(m)) return 'Битрикс не ответил вовремя — проверьте задачу в Битриксе и повторите';
  return m.replace(/^Битрикс\s+/, 'Битрикс: ');
}

export async function fetchBigTask<T extends BxBigTask = BxBigTask>(taskId: number, extraSelect: string[] = []): Promise<T | null> {
  const r = await read<{ task?: T }>('tasks.task.get', { taskId, select: [...TASK_SELECT, ...extraSelect] })
    .catch(e => { throw new BigActionError(`Битрикс не отдал задачу ${taskId}: ${humanBx(e)}`, 502); });
  return r?.task?.id ? r.task : null;
}

/** Видит ли задачу: участник сам или исполнитель/постановщик в зоне. */
export function taskVisible(t: BxBigTask, actor: BigActor): boolean {
  if (actor.zone === 'all') return true;
  const me = actor.userId;
  const people = [t.responsibleId, t.createdBy, ...(t.auditors ?? []), ...(t.accomplices ?? [])].map(String);
  if (me && people.includes(me)) return true;
  return [t.responsibleId, t.createdBy].some(id => id && (actor.zone as Set<string>).has(String(id)));
}

class Runner {
  calls: PlannedCall[] = [];
  warnings: string[] = [];
  constructor(private actor: BigActor, private dry: boolean) {}

  /** Изменение задачи: токен нажавшего, отказ — вебхук. */
  async task(method: string, params: Record<string, unknown>, note?: string): Promise<void> {
    this.calls.push({ as: 'user→webhook', method, params, note });
    if (this.dry) return;
    try {
      const r = await callAsUser(this.actor.userId, method, params);
      if (r === undefined) await writeOnce(taskWebhook(), method, params);
    } catch (e) {
      if (e instanceof UserCallUnsure) throw new BigActionError('Битрикс не ответил вовремя — обновите доску и проверьте задачу, прежде чем повторять', 504);
      if (e instanceof DealCreateError || e instanceof Error) throw new BigActionError(humanBx(e), 502);
      throw e;
    }
  }

  /** Комментарий в чат задачи от имени нажавшего. Не роняет действие: не ушёл — предупреждение. */
  async comment(taskId: number, text: string, files: number[] = [], must = false): Promise<void> {
    const author = this.actor.userId;
    this.calls.push({ as: 'chat-comment', method: 'task.commentitem.add', params: { TASKID: taskId, FIELDS: { AUTHOR_ID: author, POST_MESSAGE: text, files } } });
    if (this.dry) return;
    if (!author) { if (must) throw new BigActionError('Аккаунт не привязан к Битриксу — комментарий не от кого отправить'); this.warnings.push('Комментарий не отправлен: аккаунт не привязан к Битриксу'); return; }
    const ok = await postToTaskChat(taskId, author, text, files).catch(e => {
      if (must) throw new BigActionError(`Комментарий не ушёл: ${humanBx(e)}`, 502);
      return false;
    });
    if (!ok) { if (must) throw new BigActionError('Битрикс не принял комментарий', 502); this.warnings.push('Комментарий в задачу не ушёл'); }
  }

  /** Довести задачу до «завершена»: complete → (контроль постановщика) approve. */
  async close(taskId: number, status: string, taskControl: boolean): Promise<void> {
    if (status === '5') return;
    if (status !== '4') await this.task('tasks.task.complete', { taskId }, taskControl ? 'с контролем постановщика задача станет «ждёт контроля» (4), если закрывает не постановщик' : undefined);
    let after = status === '4' ? '4' : '5';
    if (this.dry) after = status === '4' || taskControl ? '4' : '5';
    else {
      const t = await fetchBigTask(taskId).catch(() => null);
      after = String(t?.status ?? (taskControl ? '4' : '5'));
    }
    if (after !== '5') await this.task('tasks.task.approve', { taskId }, 'приёмка: токен РОПа, если он не постановщик — вебхук админа');
  }
}

/** Выполнить действие. Проверки зоны — здесь же (роут даёт только actor). */
export async function runBigAction(action: BigAction, actor: BigActor, opts: RunOpts = {}, uploadedFiles: number[] = []): Promise<RunResult> {
  const taskId = Number(action.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) throw new BigActionError('Некорректная задача');
  const t = await fetchBigTask(taskId);
  if (!t) throw new BigActionError('Задача не найдена в Битриксе — возможно, удалена', 404);
  const groupId = Number(t.groupId);
  if (!BIG_DEALS_GROUP_IDS.includes(groupId)) throw new BigActionError('Задача не из проектов больших сделок', 403);
  if (!taskVisible(t, actor)) throw new BigActionError('Задача не в вашей зоне', 403);
  const manageOnly = action.type !== 'comment';
  if (manageOnly && !actor.canManage) throw new BigActionError('Двигать, переназначать и принимать задачи может только РОП', 403);

  const run = new Runner(actor, !!opts.dryRun);
  const status = String(t.status ?? '');
  const control = String(t.taskControl ?? '').toUpperCase() === 'Y';
  const who = actor.name ? ` (${actor.name})` : '';

  const moveTo = async (column: BigColumnKey) => {
    const stageId = Number(await stageIdForColumn(groupId, column));
    if (!stageId) throw new BigActionError(`В проекте этой задачи нет колонки «${columnTitle(column)}»`);
    if (String(stageId) === String(t.stageId)) return false;
    await run.task('task.stages.movetask', { id: taskId, stageId });
    // Журнал «в колонке с…» движка (stageSince.ts): свежий перенос — отсчёт дней с нуля.
    if (!opts.dryRun) await markColumn(taskId, column).catch(() => {});
    return true;
  };

  switch (action.type) {
    case 'move': {
      if (!COLUMN_KEYS.has(action.column)) throw new BigActionError('Неизвестная колонка');
      await moveTo(action.column);
      if (AUTO_COMPLETE_COLUMNS.has(action.column) && status !== '5') {
        await run.close(taskId, status, control);
        await run.comment(taskId, `Перенесено в «${columnTitle(action.column)}» и закрыто из канбана больших чеков (Монолитика)${who}.`);
      }
      break;
    }
    case 'reassign': {
      const rid = String(action.responsibleId ?? '');
      if (!/^\d{1,10}$/.test(rid)) throw new BigActionError('Выберите менеджера');
      if (actor.zone !== 'all' && !actor.zone.has(rid) && !(await isActiveManager(rid))) throw new BigActionError('Менеджер не найден среди действующих', 400);
      if (status === '5') throw new BigActionError('Задача уже завершена — переназначить нельзя');
      const fields: Record<string, unknown> = { RESPONSIBLE_ID: rid };
      const auditors = (t.auditors ?? []).map(String);
      if (actor.userId && actor.userId !== rid && !auditors.includes(actor.userId) && String(t.createdBy) !== actor.userId) {
        fields.AUDITORS = [...auditors, actor.userId];
      }
      if (rid !== String(t.responsibleId)) await run.task('tasks.task.update', { taskId, fields });
      const column = await currentColumn(taskId, t);
      if (column === 'new') await moveTo('assigned').catch(e => { run.warnings.push(e instanceof Error ? e.message : String(e)); });
      const tz = action.comment?.trim();
      const rname = await read<{ NAME?: string; LAST_NAME?: string }[]>('user.get', { ID: rid }).then(u => [u?.[0]?.NAME, u?.[0]?.LAST_NAME].filter(Boolean).join(' ')).catch(() => '');
      await run.comment(taskId, `[USER=${rid}]${rname || 'Менеджер'}[/USER], задача назначена на вас${who ? ` РОПом${who}` : ''}.${tz ? `\n[b]ТЗ:[/b]\n${tz.slice(0, 4000)}` : ''}`, uploadedFiles);
      break;
    }
    case 'comment': {
      const text = String(action.text ?? '').trim();
      if (!text && !uploadedFiles.length) throw new BigActionError('Пустой комментарий');
      await run.comment(taskId, text.slice(0, 6000), uploadedFiles, true);
      break;
    }
    case 'accept': {
      if (status === '5') break; // уже закрыта — цель достигнута
      if (status !== '4') throw new BigActionError('Задача не ждёт контроля — принимать нечего');
      await run.task('tasks.task.approve', { taskId });
      await run.comment(taskId, `Задача принята в канбане больших чеков (Монолитика)${who}.`);
      break;
    }
    case 'return': {
      const comment = String(action.comment ?? '').trim();
      if (comment.length < 3) throw new BigActionError('Напишите, что доделать');
      if (status !== '4') throw new BigActionError('Вернуть можно только задачу, которая ждёт контроля');
      const deadline = action.deadline ? new Date(action.deadline) : null;
      if (deadline && (!Number.isFinite(deadline.getTime()) || deadline.getTime() < Date.now())) throw new BigActionError('Новый срок уже прошёл — выберите позже');
      await run.task('tasks.task.disapprove', { taskId });
      if (deadline) await run.task('tasks.task.update', { taskId, fields: { DEADLINE: deadline.toISOString() } }).catch(e => { run.warnings.push(`Срок не изменился: ${e instanceof Error ? e.message : e}`); });
      await run.comment(taskId, `Возвращено на доработку из канбана больших чеков (Монолитика)${who}:\n${comment.slice(0, 4000)}`, uploadedFiles);
      break;
    }
    case 'complete': {
      // «Не продано → завершить»: в колонку «Не продано (проверка)», если она есть у проекта, и закрыть.
      const hasLost = Number(await stageIdForColumn(groupId, 'lost_check')) > 0;
      if (hasLost) await moveTo('lost_check');
      await run.close(taskId, status, control);
      await run.comment(taskId, `Не продано — задача закрыта из канбана больших чеков (Монолитика)${who}.`);
      break;
    }
    default:
      throw new BigActionError('Неизвестное действие');
  }

  const card = opts.dryRun ? null : await refreshTask(taskId).catch(e => {
    console.warn(`[big-deals action] refreshTask ${taskId}:`, e instanceof Error ? e.message : e);
    return null;
  });
  return { card, calls: run.calls, warnings: run.warnings };
}

/** Текущая колонка задачи — по карточке движка (он знает соответствие стадий проекта колонкам). */
async function currentColumn(taskId: number, t: BxBigTask): Promise<BigColumnKey | null> {
  const newStage = Number(await stageIdForColumn(Number(t.groupId), 'new').catch(() => 0));
  if (newStage && String(newStage) === String(t.stageId)) return 'new';
  // stageId 0 у Битрикса — «первая стадия» (задача ещё не двигалась) = «Новые».
  if (!Number(t.stageId)) return 'new';
  void taskId;
  return null;
}

async function isActiveManager(id: string): Promise<boolean> {
  const { analyticsDb } = await import('@/lib/db/clients');
  const r = await analyticsDb().query(`SELECT 1 FROM sa.org_resolved_hierarchy WHERE is_active AND manager_bitrix_user_id = $1 LIMIT 1`, [id]).catch(() => ({ rows: [] }));
  return r.rows.length > 0;
}
