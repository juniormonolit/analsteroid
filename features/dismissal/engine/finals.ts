// Завершающие шаги прогона (v2, после всех строк): сообщение РОПу со ссылками на задачи без сделок и
// задача + сообщение Анне Кузнецовой «сменить пароль на аккаунте уволенного». Статусы — в dismissal_runs.finals;
// сделанный шаг не повторяется (retry переводит в pending только шаги с ошибкой). Задача «сменить пароль»
// создаётся writeOnce: перед созданием ищем уже созданную этим прогоном (таймаут после записи не задвоит её).
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { PASSWORD_RESET_BITRIX_ID, type DismissalFinals } from '../types';
import { PORTAL, readAll, taskUrl, writeTask } from './bx';
import type { Pace } from './execute';
import { getFinals, itemsOfKind, saveFinals, type ClaimedRun } from './store';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_LINKS = 60;
const appBase = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');
const bbSafe = (s: string) => s.replace(/[[\]]/g, ' ').trim();

/** Завтра 19:00 по Москве (ISO с поясом). */
function tomorrow19Msk(now = Date.now()): string {
  const msk = new Date(now + 3 * 3600_000 + 86_400_000);
  return `${msk.toISOString().slice(0, 10)}T19:00:00+03:00`;
}

async function ropMessage(run: ClaimedRun, pace: Pace): Promise<DismissalFinals['ropMessage']> {
  if (run.plan.notifyRop === false) return { status: 'skipped', detail: 'Выключено в плане' };
  const rop = run.plan.ropBitrixId ?? null;
  if (!rop) return { status: 'skipped', detail: 'РОП не задан — сообщать некому' };
  const rows = await itemsOfKind(run.id, ['task_other', 'activity_other']);
  const mine = rows.filter(x => x.status === 'done' && x.action === 'transfer' && x.target === rop);
  const tasks = mine.filter(x => x.kind === 'task_other');
  const acts = mine.filter(x => x.kind === 'activity_other').length;
  if (!tasks.length && !acts) return { status: 'skipped', detail: 'На РОПа ничего не перевели — сообщать нечего' };
  const name = bbSafe(run.source.name);
  const lines = tasks.slice(0, MAX_LINKS).map((t, i) => `${i + 1}. [URL=${taskUrl(t.entityId, rop)}]${bbSafe(t.title) || `Задача #${t.entityId}`}[/URL]`);
  const msg = [
    '[B]Увольнятор[/B]',
    `У тебя уволился менеджер ${name}.`,
    tasks.length ? `Его задачи, не связанные со сделками, уже переведены на тебя (${tasks.length}):` : '',
    ...lines,
    tasks.length > MAX_LINKS ? `…и ещё ${tasks.length - MAX_LINKS}.` : '',
    acts ? `Ещё на тебя переведены его дела без сделок: ${acts}.` : '',
    'Делегируй вручную или сделай сам.',
    `[URL=${appBase()}/dismissal/${run.id}]Прогон в Увольняторе[/URL]`,
  ].filter(Boolean).join('\n');
  await pace('call');
  const id = await sendBitrixBotMessage(String(rop), msg, undefined, 'dismissal');
  if (!id) return { status: 'error', detail: 'Бот не отправил сообщение (функция «Увольнятор» выключена в настройках бота?)' };
  return { status: 'done', detail: `Отправлено РОПу: задач ${tasks.length}${acts ? `, дел ${acts}` : ''}` };
}

async function passwordReset(run: ClaimedRun, prev: DismissalFinals['passwordReset'], startedAt: Date | null, pace: Pace): Promise<DismissalFinals['passwordReset']> {
  if (run.plan.passwordReset === false) return { status: 'skipped', detail: 'Выключено в плане', taskId: null };
  const name = bbSafe(run.source.name);
  const profile = `${PORTAL}/company/personal/user/${run.sourceId}/`;
  const title = `Сменить пароль на аккаунте ${name} (уволен)`;
  let taskId = prev.taskId ?? null;
  if (!taskId) {
    // Уже создана этим прогоном (запись прошла, ответ потерялся)? — не задваиваем.
    await pace('call');
    const found = await readAll<{ id: string; title?: string }>('tasks.task.list', {
      filter: { RESPONSIBLE_ID: PASSWORD_RESET_BITRIX_ID, TITLE: title, ...(startedAt ? { '>=CREATED_DATE': new Date(startedAt).toISOString() } : {}) },
      select: ['ID', 'TITLE'],
    }, { pick: r => ((r as { tasks?: { id: string; title?: string }[] })?.tasks ?? []) });
    taskId = Number(found.find(t => t.title?.trim() === title)?.id) || null;
  }
  if (!taskId) {
    await pace('call');
    const res = await writeTask<{ task?: { id?: string | number } }>('tasks.task.add', {
      fields: {
        TITLE: title,
        DESCRIPTION: [
          `Сотрудник ${name} уволен, его сделки и задачи переданы через Увольнятор.`,
          `Смени пароль на его аккаунте Битрикса: [URL=${profile}]${profile}[/URL]`,
          `Прогон: [URL=${appBase()}/dismissal/${run.id}]${appBase()}/dismissal/${run.id}[/URL]`,
        ].join('\n'),
        RESPONSIBLE_ID: PASSWORD_RESET_BITRIX_ID,
        ...(run.createdByBitrixId ? { CREATED_BY: run.createdByBitrixId } : {}),
        DEADLINE: tomorrow19Msk(),
      },
    });
    taskId = Number(res?.task?.id) || null;
    if (!taskId) return { status: 'error', detail: 'Битрикс не вернул id задачи — проверьте задачи Кузнецовой, прежде чем повторять', taskId: null };
    // Задача есть — запоминаем сразу, чтобы повтор (сбой на сообщении) её не задвоил.
    const cur = await getFinals(run.id);
    if (cur) await saveFinals(run.id, { ...cur.finals, passwordReset: { status: 'pending', detail: 'Задача поставлена, сообщение не отправлено', taskId } });
  }
  const msg = [
    '[B]Увольнятор[/B]',
    `Уволен сотрудник ${name}. Смени, пожалуйста, пароль на его аккаунте: [URL=${profile}]профиль[/URL].`,
    `Задача: [URL=${taskUrl(taskId, PASSWORD_RESET_BITRIX_ID)}]#${taskId}[/URL] (срок — завтра 19:00).`,
  ].join('\n');
  await pace('call');
  const sent = await sendBitrixBotMessage(String(PASSWORD_RESET_BITRIX_ID), msg, undefined, 'dismissal');
  if (!sent) return { status: 'error', detail: `Задача #${taskId} поставлена, но бот не отправил сообщение (функция выключена?)`, taskId, taskUrl: taskUrl(taskId, PASSWORD_RESET_BITRIX_ID) };
  return { status: 'done', detail: `Задача #${taskId} поставлена, сообщение отправлено`, taskId, taskUrl: taskUrl(taskId, PASSWORD_RESET_BITRIX_ID) };
}

/** Выполнить незавершённые завершающие шаги. Ошибку шага пишем в finals и идём дальше (прогон всё равно done). */
export async function runFinals(run: ClaimedRun, pace: Pace): Promise<DismissalFinals> {
  const cur = await getFinals(run.id);
  if (!cur) throw new Error('Прогон не найден');
  const f = cur.finals;
  if (f.ropMessage.status === 'pending') {
    try { f.ropMessage = await ropMessage(run, pace); } catch (e) { f.ropMessage = { status: 'error', detail: errMsg(e).slice(0, 500) }; }
    await saveFinals(run.id, f);
  }
  if (f.passwordReset.status === 'pending') {
    const latest = (await getFinals(run.id))?.finals.passwordReset ?? f.passwordReset;
    try { f.passwordReset = await passwordReset(run, latest, cur.startedAt, pace); } catch (e) {
      // taskId мог успеть сохраниться промежуточно — берём свежий, чтобы повтор не задвоил задачу.
      const again = (await getFinals(run.id).catch(() => null))?.finals.passwordReset ?? latest;
      f.passwordReset = { ...again, status: 'error', detail: errMsg(e).slice(0, 500) };
    }
    await saveFinals(run.id, f);
  }
  return f;
}
