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
// «Принять» (владелец 18.11) = «ответ увидел, работаем дальше»: задачу НЕ закрываем — tasks.task.disapprove
// возвращает её из «ждёт контроля» в работу, в чат — «РОП посмотрел ответ, работаем дальше», срок — по желанию.
// Закрывают задачу только «Не продано → завершить», перенос в AUTO_COMPLETE_COLUMNS и массовое закрытие (massClose.ts).
//
// Имя нажавшего — в КАЖДОМ комментарии («из Монолитики · Имя»), даже если действие ушло вебхуком; ушло вебхуком —
// в ответе warning «выполнено от имени служебной учётки» (в истории задачи Битрикса будет админ, а не РОП).
//
// Сухой прогон: runBigAction(..., { dryRun: true }) — ничего не пишет, только читает задачу и возвращает
// список REST-вызовов, которые ушли бы (scratchpad-скрипт проверки, без записи в прод-портал).
import { BIG_COLUMNS, BIG_DEALS_GROUP_IDS, AUTO_COMPLETE_COLUMNS, type BigColumnKey } from './config';
import type { BigAction, BigTaskCard } from './types';
import { stageIdForColumn } from './stages';
import { cardFromSnapshot, refreshTask } from './load';
import { canManageTask, canSeeTask, type TaskPeople } from './visibility';
import { markColumn } from './stageSince';
import { bx } from '@/lib/bitrix/notify';
import { crmReadWebhook } from './rest';
import { DealCreateError, postToTaskChat, read, ropOfManager, taskWebhook, writeOnce } from '@/features/repeat-kanban/engine/createDeal';
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
  /** Логин Монолитики — подпись в комментарии, если нет ни имени, ни Bitrix id (роут дописывает). */
  login?: string | null;
}

/** Подпись нажавшего для комментариев — есть всегда. */
export function actorLabel(actor: BigActor): string {
  return actor.name?.trim() || actor.login?.trim() || (actor.userId ? `сотрудник ${actor.userId}` : 'пользователь Монолитики');
}
export const VIA_WEBHOOK_WARNING = 'Выполнено от имени служебной учётки Битрикса: вашего токена нет или Битрикс не дал вам прав — в истории задачи будет админ, имя нажавшего указано в комментарии';

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
export interface RunResult { card: BigTaskCard | null; calls: PlannedCall[]; warnings: string[]; viaWebhook: boolean }

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

/** Люди задачи для canSeeTask/canManageTask движка (visibility.ts): свежие поля из Битрикса + ответственный сделки
 *  из снимка доски (его нет в tasks.task.get) — иначе карточка, видимая на доске по сделке, отвечала бы 403. */
export async function taskPeople(t: BxBigTask): Promise<TaskPeople> {
  const snap = await cardFromSnapshot(Number(t.id)).catch(() => null);
  return {
    responsibleId: t.responsibleId, createdBy: t.createdBy, auditors: t.auditors ?? [], accomplices: t.accomplices ?? [],
    dealAssignedId: snap?.deal?.assigned?.id ?? null,
  };
}

class Runner {
  calls: PlannedCall[] = [];
  warnings: string[] = [];
  /** Хоть одно изменение задачи ушло вебхуком (не от имени нажавшего). */
  viaWebhook = false;
  constructor(private actor: BigActor, private dry: boolean) {}

  /** Изменение задачи: токен нажавшего, отказ — вебхук. */
  async task(method: string, params: Record<string, unknown>, note?: string): Promise<void> {
    this.calls.push({ as: 'user→webhook', method, params, note });
    if (this.dry) return;
    try {
      const r = await callAsUser(this.actor.userId, method, params);
      if (r === undefined) { this.viaWebhook = true; await writeOnce(taskWebhook(), method, params); }
    } catch (e) {
      if (e instanceof UserCallUnsure) throw new BigActionError('Битрикс не ответил вовремя — обновите доску и проверьте задачу, прежде чем повторять', 504);
      if (e instanceof DealCreateError || e instanceof Error) throw new BigActionError(humanBx(e), 502);
      throw e;
    }
  }

  /** Комментарий в чат задачи от имени нажавшего. Не роняет действие: не ушёл — предупреждение. */
  async comment(taskId: number, text: string, files: number[] = [], must = false): Promise<void> {
    // Задача нового вида (с чатом): task.commentitem.add кладёт в чат только текст, UF_FORUM_MESSAGE_DOC Битрикс
    // молча отбрасывает (18.11, задача 176566). Осипов 23.10: «фотки так и не добавить, и надо писать 123» —
    // картинка требовала текст и всё равно не доходила. Теперь: текст (если есть) — как раньше, от имени нажавшего;
    // файлы — прямо в IM-чат задачи (im.disk.file.commit с DISK_ID, вебхук владельца: у РОПов без OAuth-токена
    // от их имени файл не отправить), с подписью, от кого. Текст к картинке необязателен.
    let chatFiles: number[] = [];
    let chatId = 0;
    if (files.length && !this.dry) {
      chatId = await taskChatId(taskId);
      if (chatId) { chatFiles = files; files = []; }
    }
    const author = this.actor.userId;
    if (text.trim() || files.length || !chatFiles.length) {
      // Аккаунт не привязан к Битриксу — комментарий уходит от владельца вебхука, имя нажавшего — в тексте.
      const body = author ? text : `[b]${actorLabel(this.actor)}[/b] (из Монолитики):\n${text}`;
      this.calls.push({ as: 'chat-comment', method: 'task.commentitem.add', params: { TASKID: taskId, FIELDS: { AUTHOR_ID: author ?? '(вебхук)', POST_MESSAGE: body, files } } });
      if (!this.dry) {
        if (!author) this.viaWebhook = true;
        const ok = await (author ? postToTaskChat(taskId, author, body, files) : postAsWebhook(taskId, body, files)).catch(e => {
          if (must) throw new BigActionError(`Комментарий не ушёл: ${humanBx(e)}`, 502);
          return false;
        });
        if (!ok) { if (must) throw new BigActionError('Битрикс не принял комментарий', 502); this.warnings.push('Комментарий в задачу не ушёл'); }
      }
    }
    if (chatFiles.length) {
      const caption = `Файл от ${author ? `[USER=${author}]${actorLabel(this.actor)}[/USER]` : actorLabel(this.actor)} (из Монолитики)`;
      this.calls.push({ as: 'webhook', method: 'im.disk.file.commit', params: { CHAT_ID: chatId, DISK_ID: chatFiles, MESSAGE: caption } });
      this.viaWebhook = true;
      const ok = await writeOnce<unknown>(taskWebhook(), 'im.disk.file.commit', { CHAT_ID: chatId, DISK_ID: chatFiles, MESSAGE: caption })
        .then(r => !!r).catch(e => { console.warn('[big-deals] im.disk.file.commit', humanBx(e)); return false; });
      if (!ok) {
        if (must && !text.trim()) throw new BigActionError(CHAT_FILES_ERROR, 502);
        this.warnings.push(CHAT_FILES_WARNING);
      }
    }
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

const CHAT_FILES_ERROR = 'Битрикс не принял картинку в чат задачи — попробуйте ещё раз или отправьте её в чате задачи в Битриксе.';
const CHAT_FILES_WARNING = 'Текст ушёл, а картинку Битрикс в чат задачи не принял — отправьте её в чате задачи в Битриксе.';

/** Чат задачи (задачи нового вида): комментарии — сообщения IM-чата, файлы через commentitem не доходят. 0 — чата нет. */
async function taskChatId(taskId: number): Promise<number> {
  const t = await fetchBigTask<BxBigTask & { chatId?: number | string | null }>(taskId, ['CHAT_ID']).catch(() => null);
  return Number(t?.chatId) || 0;
}

async function postAsWebhook(taskId: number, text: string, files: number[]): Promise<boolean> {
  const r = await writeOnce<number>(taskWebhook(), 'task.commentitem.add', {
    TASKID: taskId, FIELDS: { POST_MESSAGE: text, ...(files.length ? { UF_FORUM_MESSAGE_DOC: files.map(id => `n${id}`) } : {}) },
  });
  return Number(r) > 0;
}

const fmtDeadline = (d: Date) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function parseDeadline(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime()) || d.getTime() < Date.now()) throw new BigActionError('Новый срок уже прошёл — выберите позже');
  return d;
}

/** Выполнить действие. Проверки зоны — здесь же (роут даёт только actor). */
export async function runBigAction(action: BigAction, actor: BigActor, opts: RunOpts = {}, uploadedFiles: number[] = []): Promise<RunResult> {
  const taskId = Number(action.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) throw new BigActionError('Некорректная задача');
  const t = await fetchBigTask(taskId);
  if (!t) throw new BigActionError('Задача не найдена в Битриксе — возможно, удалена', 404);
  const groupId = Number(t.groupId);
  if (!BIG_DEALS_GROUP_IDS.includes(groupId)) throw new BigActionError('Задача не из проектов больших сделок', 403);
  const people = await taskPeople(t);
  if (!canSeeTask(people, actor)) throw new BigActionError('Задача не в вашей зоне', 403);
  const manageOnly = action.type !== 'comment';
  if (manageOnly && !canManageTask(people, actor)) throw new BigActionError('Двигать, переназначать, принимать задачи и менять участников может только РОП', 403);

  const run = new Runner(actor, !!opts.dryRun);
  const status = String(t.status ?? '');
  const control = String(t.taskControl ?? '').toUpperCase() === 'Y';
  const who = ` · ${actorLabel(actor)}`;

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
        await run.comment(taskId, `Перенесено в «${columnTitle(action.column)}» и закрыто из канбана больших чеков (Монолитика${who}).`);
      }
      break;
    }
    case 'reassign': {
      const rid = String(action.responsibleId ?? '');
      if (!/^\d{1,10}$/.test(rid)) throw new BigActionError('Выберите менеджера');
      if (actor.zone !== 'all' && !actor.zone.has(rid) && !(await isActiveManager(rid))) throw new BigActionError('Менеджер не найден среди действующих', 400);
      if (status === '5') throw new BigActionError('Задача уже завершена — переназначить нельзя');
      const fields: Record<string, unknown> = {};
      if (rid !== String(t.responsibleId)) fields.RESPONSIBLE_ID = rid;
      const auditors = (t.auditors ?? []).map(String);
      const addAuditors: string[] = [];
      if (actor.userId && actor.userId !== rid && !auditors.includes(actor.userId) && String(t.createdBy) !== actor.userId) addAuditors.push(actor.userId);
      // РОП нового исполнителя — ВСЕГДА наблюдателем (РОП Осипов 18.11). Нажавший сам РОП / уже наблюдатель — не дублируем.
      const rop = await ropOfManager(rid).catch(e => { run.warnings.push(`РОП исполнителя не определён: ${e instanceof Error ? e.message : e}`); return null; });
      if (rop && rop !== rid && !auditors.includes(rop) && !addAuditors.includes(rop)) addAuditors.push(rop);
      if (addAuditors.length) fields.AUDITORS = [...auditors, ...addAuditors];
      if (Object.keys(fields).length) await run.task('tasks.task.update', { taskId, fields }, rop ? `РОП исполнителя по оргструктуре: ${rop}` : 'РОП исполнителя в оргструктуре не найден');
      const column = await currentColumn(taskId, t);
      if (column === 'new') await moveTo('assigned').catch(e => { run.warnings.push(e instanceof Error ? e.message : String(e)); });
      const tz = action.comment?.trim();
      const rname = await read<{ NAME?: string; LAST_NAME?: string }[]>('user.get', { ID: rid }).then(u => [u?.[0]?.NAME, u?.[0]?.LAST_NAME].filter(Boolean).join(' ')).catch(() => '');
      await run.comment(taskId, `[USER=${rid}]${rname || 'Менеджер'}[/USER], задача назначена на вас из Монолитики${who}.${tz ? `\n[b]ТЗ:[/b]\n${tz.slice(0, 4000)}` : ''}`, uploadedFiles);
      break;
    }
    case 'comment': {
      const text = String(action.text ?? '').trim();
      if (!text && !uploadedFiles.length) throw new BigActionError('Пустой комментарий');
      await run.comment(taskId, text.slice(0, 6000), uploadedFiles, true);
      break;
    }
    case 'accept': {
      // «Ответ увидел, работаем дальше» — НЕ закрывать (владелец 18.11). Ждёт контроля → disapprove (обратно в работу).
      if (status === '5') throw new BigActionError('Задача уже завершена');
      const deadline = parseDeadline(action.deadline);
      if (status === '4') await run.task('tasks.task.disapprove', { taskId }, 'из «ждёт контроля» обратно в работу — задача НЕ закрывается');
      if (deadline) await run.task('tasks.task.update', { taskId, fields: { DEADLINE: deadline.toISOString() } }).catch(e => { run.warnings.push(`Срок не изменился: ${e instanceof Error ? e.message : e}`); });
      const text = String(action.comment ?? '').trim();
      await run.comment(taskId, `РОП посмотрел ответ, работаем дальше (Монолитика${who}).${deadline ? `\nНовый срок: ${fmtDeadline(deadline)}.` : ''}${text ? `\n\n${emphasize(text.slice(0, 4000))}` : ''}`, uploadedFiles);
      break;
    }
    case 'approve': {
      // Просто «Принять» (РОП Осипов 19.11: «хотел просто принять задачу, а там только „работаем дальше“, а там продажа»):
      // работа принята — задача закрывается (ждёт контроля → approve; в работе → complete + approve).
      // Сделка выиграна — задача заодно встаёт в «Продано», если такая колонка есть у проекта.
      if (status === '5') throw new BigActionError('Задача уже завершена');
      const dealId = Number((t.ufCrmTask ?? []).map(String).find(x => /^D_\d+$/.test(x))?.slice(2)) || 0;
      const won = dealId > 0 && await (bx(crmReadWebhook(), 'crm.deal.get', { id: dealId }) as Promise<{ result?: { STAGE_SEMANTIC_ID?: string } }>)
        .then(r => r.result?.STAGE_SEMANTIC_ID === 'S').catch(() => false);
      if (won && Number(await stageIdForColumn(groupId, 'sold')) > 0) await moveTo('sold').catch(e => { run.warnings.push(e instanceof Error ? e.message : String(e)); });
      await run.close(taskId, status, control);
      const text = String(action.comment ?? '').trim();
      await run.comment(taskId, `Работа принята, задача закрыта из канбана больших чеков (Монолитика${who}).${text ? `\n${text.slice(0, 4000)}` : ''}`);
      break;
    }
    case 'participants': {
      const ids = (v: unknown): string[] | null => {
        if (v === undefined) return null;
        if (!Array.isArray(v) || v.length > 50 || !v.every(x => /^\d{1,10}$/.test(String(x)))) throw new BigActionError('Некорректный список участников');
        return [...new Set(v.map(String))];
      };
      const auditors = ids(action.auditors) ?? [];
      const accomplices = ids(action.accomplices);
      const curA = (t.auditors ?? []).map(String);
      const curC = (t.accomplices ?? []).map(String);
      const same = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));
      const fields: Record<string, unknown> = {};
      if (!same(auditors, curA)) fields.AUDITORS = auditors.length ? auditors : [''];
      if (accomplices && !same(accomplices, curC)) fields.ACCOMPLICES = accomplices.length ? accomplices : [''];
      if (!Object.keys(fields).length) break;
      await run.task('tasks.task.update', { taskId, fields });
      // В истории задачи изменение видно от имени нажавшего; ушло вебхуком — подпишем в чате, кто это сделал.
      if (run.viaWebhook || opts.dryRun) {
        const diff = (now: string[], was: string[]) => ({ add: now.filter(x => !was.includes(x)), del: was.filter(x => !now.includes(x)) });
        const a = diff(auditors, curA);
        const c = accomplices ? diff(accomplices, curC) : { add: [], del: [] };
        const all = [...new Set([...a.add, ...a.del, ...c.add, ...c.del])];
        const names = new Map<string, string>();
        if (all.length) {
          const us = await read<{ ID: string; NAME?: string; LAST_NAME?: string }[]>('user.get', { filter: { ID: all } }).catch(() => []);
          for (const u of us ?? []) names.set(String(u.ID), [u.NAME, u.LAST_NAME].filter(Boolean).join(' '));
        }
        const list = (ids: string[]) => ids.map(id => `[USER=${id}]${names.get(id) || `сотрудник ${id}`}[/USER]`).join(', ');
        const parts = [
          a.add.length ? `добавлены наблюдатели ${list(a.add)}` : '', a.del.length ? `убраны наблюдатели ${list(a.del)}` : '',
          c.add.length ? `добавлены соисполнители ${list(c.add)}` : '', c.del.length ? `убраны соисполнители ${list(c.del)}` : '',
        ];
        await run.comment(taskId, `Участники задачи изменены из Монолитики${who}: ${parts.filter(Boolean).join('; ')}.`);
      }
      break;
    }
    case 'return': {
      // Текст необязателен (Осипов 23.11: «заебало 123 писать при возврате задачи»).
      const comment = String(action.comment ?? '').trim();
      if (status !== '4') throw new BigActionError('Вернуть можно только задачу, которая ждёт контроля');
      const deadline = parseDeadline(action.deadline);
      await run.task('tasks.task.disapprove', { taskId });
      if (deadline) await run.task('tasks.task.update', { taskId, fields: { DEADLINE: deadline.toISOString() } }).catch(e => { run.warnings.push(`Срок не изменился: ${e instanceof Error ? e.message : e}`); });
      // Сам вопрос — отдельным абзацем жирным (Осипов 23.11: «сливается всё, может вопрос выделим?»).
      await run.comment(taskId, `Возвращено на доработку из канбана больших чеков (Монолитика${who}).${deadline ? `\nНовый срок: ${fmtDeadline(deadline)}.` : ''}${comment ? `\n\n${emphasize(comment.slice(0, 4000))}` : ''}`, uploadedFiles);
      break;
    }
    case 'complete': {
      // «Не продано → завершить» из карточки жмёт РОП — он работу уже проверил: сразу в «Не продано (проверено)»
      // (Осипов 23.11). Нет такой колонки у проекта — в «Не продано (проверка)», нет и её — просто закрыть.
      const lostCol = Number(await stageIdForColumn(groupId, 'lost_done')) > 0 ? 'lost_done'
        : Number(await stageIdForColumn(groupId, 'lost_check')) > 0 ? 'lost_check' : null;
      if (lostCol) await moveTo(lostCol);
      await run.close(taskId, status, control);
      await run.comment(taskId, `Не продано — задача закрыта из канбана больших чеков (Монолитика${who}).`);
      break;
    }
    case 'renew': {
      // «Возобновить» завершённую задачу (РОП 18.11): tasks.task.renew + обязательный новый срок + комментарий кто и до какого.
      if (status !== '5') throw new BigActionError('Задача не завершена — возобновлять нечего');
      const deadline = parseDeadline(action.deadline);
      if (!deadline) throw new BigActionError('Укажите новый срок исполнения');
      await run.task('tasks.task.renew', { taskId });
      await run.task('tasks.task.update', { taskId, fields: { DEADLINE: deadline.toISOString() } }).catch(e => { run.warnings.push(`Срок не изменился: ${e instanceof Error ? e.message : e}`); });
      const text = String(action.comment ?? '').trim();
      await run.comment(taskId, `Задача возобновлена из канбана больших чеков (Монолитика${who}). Новый срок: ${fmtDeadline(deadline)}.${text ? `\n${text.slice(0, 4000)}` : ''}`);
      break;
    }
    case 'deadline': {
      if (status === '5') throw new BigActionError('Задача завершена — сначала возобновите её');
      const deadline = parseDeadline(action.deadline);
      if (!deadline) throw new BigActionError('Укажите срок');
      await run.task('tasks.task.update', { taskId, fields: { DEADLINE: deadline.toISOString() } });
      if (run.viaWebhook || opts.dryRun) await run.comment(taskId, `Срок задачи изменён из Монолитики${who}: ${fmtDeadline(deadline)}.`);
      break;
    }
    default:
      throw new BigActionError('Неизвестное действие');
  }

  const card = opts.dryRun ? null : await refreshTask(taskId).catch(e => {
    console.warn(`[big-deals action] refreshTask ${taskId}:`, e instanceof Error ? e.message : e);
    return null;
  });
  if (run.viaWebhook && !opts.dryRun) run.warnings.push(VIA_WEBHOOK_WARNING);
  return { card, calls: run.calls, warnings: run.warnings, viaWebhook: run.viaWebhook };
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

/** Текст РОПа менеджеру — жирным, построчно (BB-код [B] через перенос строки Битрикс рвёт). */
function emphasize(text: string): string {
  return text.split('\n').map(l => (l.trim() ? `[b]${l}[/b]` : l)).join('\n');
}

/**
 * Действующий ли менеджер (переназначение вне своей зоны). База недоступна (таймауты 23.11) — не отказываем
 * молча «не найден», а спрашиваем Битрикс: активный сотрудник = можно (Осипов 23.11: «всё ещё не ставится менеджер»).
 */
async function isActiveManager(id: string): Promise<boolean> {
  const { analyticsDb } = await import('@/lib/db/clients');
  const r = await analyticsDb().query(`SELECT 1 FROM sa.org_resolved_hierarchy WHERE is_active AND manager_bitrix_user_id = $1 LIMIT 1`, [id])
    .catch(e => { console.warn('[big-deals] isActiveManager: база недоступна, проверяю по Битриксу:', e instanceof Error ? e.message : e); return null; });
  if (r) return r.rows.length > 0;
  const u = await read<{ ACTIVE?: boolean | string }[]>('user.get', { ID: id }).catch(() => null);
  return u?.[0]?.ACTIVE === true || u?.[0]?.ACTIVE === 'Y';
}
