// Последний комментарий по задаче — на карточке канбана (владелец 21.10: «последний
// комментарий (результат задачи) должен отображаться в карточке»; принимают задачи РОПы
// по-прежнему в Битриксе — им так удобнее, на карточке видно, ЧТО менеджер ответил).
//
// Источники (замер 21.10): формальный «Результат» задачи (sa.bitrix_task_current.results)
// заполнен у 3 задач из 57 сданных — менеджеры пишут обычным сообщением в чат задачи.
// Поэтому: результат, если есть и он свежее; иначе последнее сообщение ЧЕЛОВЕКА в чате
// задачи (im.dialog.messages.get; системные «начал выполнять / изменил срок» — author_id 0).
// Чат задачи — chatId из tasks.task.list (не меняется, кэш навсегда), сообщения — кэш 3 мин.
// Грузится отдельным запросом после доски, только для видимых карточек: доску не тормозит.
import { bx } from '@/lib/bitrix/notify';
import { analyticsDb } from '@/lib/db/clients';
import { REPEAT_PROJECT_GROUP_ID } from './config';

export interface TaskNote {
  taskId: number;
  text: string;
  author: string | null;
  authorId: string | null;
  at: string;
  /** Формальный «Результат» задачи (а не просто сообщение в чате). */
  isResult: boolean;
}

const NOTE_TTL_MS = 3 * 60_000;
const PER_CALL = 50;
interface State { chats: Map<number, number | null>; notes: Map<number, { at: number; note: TaskNote | null }> }
const g = globalThis as unknown as { __repeatTaskNotes?: State };
const st: State = (g.__repeatTaskNotes ??= { chats: new Map(), notes: new Map() });

/** BB-коды Битрикса → текст: [USER=1]Имя[/USER] → Имя, [URL=…]текст[/URL] → текст, [p]/[b]… — прочь. */
export function stripBb(s: string): string {
  return s
    .replace(/\[(USER|URL|CHAT|DISK)[^\]]*\]([\s\S]*?)\[\/\1\]/gi, '$2')
    .replace(/\[TIMESTAMP=\d+[^\]]*\]/gi, '')
    .replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function batch(cmd: Record<string, string>): Promise<Record<string, unknown>> {
  const webhook = process.env.BITRIX_WEBHOOK_URL ?? '';
  if (!webhook || !Object.keys(cmd).length) return {};
  const res = await bx(webhook, 'batch', { halt: 0, cmd }) as { result?: { result?: Record<string, unknown> } };
  return res.result?.result ?? {};
}

async function resolveChats(taskIds: number[]): Promise<void> {
  const todo = taskIds.filter(id => !st.chats.has(id));
  const cmd: Record<string, string> = {};
  for (let i = 0; i < todo.length; i += PER_CALL) {
    const ids = todo.slice(i, i + PER_CALL);
    cmd[`t${i}`] = `tasks.task.list?${ids.map(id => `filter[ID][]=${id}`).join('&')}&select[]=ID&select[]=CHAT_ID`;
  }
  // batch — до 50 команд за раз.
  const keys = Object.keys(cmd);
  for (let i = 0; i < keys.length; i += 50) {
    const part = Object.fromEntries(keys.slice(i, i + 50).map(k => [k, cmd[k]]));
    const out = await batch(part);
    for (const v of Object.values(out)) {
      for (const t of ((v as { tasks?: { id: string; chatId?: string | null }[] })?.tasks ?? [])) {
        st.chats.set(Number(t.id), t.chatId ? Number(t.chatId) : null);
      }
    }
  }
  for (const id of todo) if (!st.chats.has(id)) st.chats.set(id, null);
}

interface ImMessage { id: number; author_id: number; date: string; text: string }
interface ImUser { id: number; name: string }

/** Последние комментарии по задачам (только задачи проекта «Повторные продажи»). */
export async function fetchTaskNotes(taskIds: number[]): Promise<Map<number, TaskNote>> {
  const ids = [...new Set(taskIds.filter(n => Number.isInteger(n) && n > 0))].slice(0, 400);
  const out = new Map<number, TaskNote>();
  if (!ids.length) return out;
  const now = Date.now();
  const stale = ids.filter(id => { const c = st.notes.get(id); return !c || now - c.at > NOTE_TTL_MS; });

  if (stale.length) {
    // Формальные результаты и принадлежность проекту — из копии Битрикса (без запросов в Битрикс).
    const r = await analyticsDb().query<{ task_id: string; results: { text?: string; createdAt?: string; createdBy?: number }[] }>(
      `SELECT task_id::text AS task_id, results FROM sa.bitrix_task_current
        WHERE task_id = ANY($1::bigint[]) AND group_id = $2 AND NOT is_deleted`,
      [stale, REPEAT_PROJECT_GROUP_ID],
    );
    const inProject = r.rows.map(x => Number(x.task_id));
    const results = new Map<number, TaskNote>();
    for (const x of r.rows) {
      const last = [...(x.results ?? [])].filter(y => y.text).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (last?.text && last.createdAt) {
        results.set(Number(x.task_id), {
          taskId: Number(x.task_id), text: stripBb(last.text), author: null,
          authorId: last.createdBy ? String(last.createdBy) : null, at: new Date(last.createdAt).toISOString(), isResult: true,
        });
      }
    }

    const fromChat = new Map<number, TaskNote>();
    try {
      await resolveChats(inProject);
      const withChat = inProject.filter(id => st.chats.get(id));
      for (let i = 0; i < withChat.length; i += 50) {
        const part = withChat.slice(i, i + 50);
        const res = await batch(Object.fromEntries(part.map(id => [`m${id}`, `im.dialog.messages.get?DIALOG_ID=chat${st.chats.get(id)}&LIMIT=20`])));
        for (const id of part) {
          const v = res[`m${id}`] as { messages?: ImMessage[]; users?: ImUser[] } | undefined;
          const human = (v?.messages ?? []).filter(m => m.author_id > 0 && stripBb(m.text ?? '').length > 0)
            .sort((a, b) => b.date.localeCompare(a.date))[0];
          if (!human) continue;
          const user = (v?.users ?? []).find(u => Number(u.id) === human.author_id);
          fromChat.set(id, {
            taskId: id, text: stripBb(human.text), author: user?.name ?? null, authorId: String(human.author_id),
            at: new Date(human.date).toISOString(), isResult: false,
          });
        }
      }
    } catch (e) {
      console.warn('[repeat-kanban] комментарии задач из Битрикса:', e instanceof Error ? e.message : e);
    }

    // Автор формального результата — по оргструктуре (в results только id).
    const needNames = [...results.values()].map(n => n.authorId).filter((x): x is string => !!x);
    const names = needNames.length ? new Map((await analyticsDb().query<{ id: string; name: string }>(
      `SELECT manager_bitrix_user_id::text AS id, manager_name AS name FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::text = ANY($1::text[])`,
      [needNames],
    ).catch(() => ({ rows: [] as { id: string; name: string }[] }))).rows.map(x => [x.id, x.name])) : new Map<string, string>();
    for (const id of stale) {
      const a = results.get(id), b = fromChat.get(id);
      // Результат главнее, если он не старше последнего сообщения.
      const note = a && (!b || a.at >= b.at) ? { ...a, author: names.get(a.authorId ?? '') ?? null } : b ?? a ?? null;
      st.notes.set(id, { at: now, note });
    }
  }
  for (const id of ids) {
    const n = st.notes.get(id)?.note;
    if (n) out.set(id, { ...n, text: n.text.length > 600 ? `${n.text.slice(0, 600)}…` : n.text });
  }
  return out;
}
