// Последний комментарий по задаче — на карточке канбана (владелец 21.10: «последний
// комментарий (результат задачи) должен отображаться в карточке»; принимают задачи РОПы
// по-прежнему в Битриксе — им так удобнее, на карточке видно, ЧТО менеджер ответил).
//
// Источники (замер 21.10): формальный «Результат» задачи (sa.bitrix_task_current.results)
// заполнен у 3 задач из 57 сданных — менеджеры пишут обычным сообщением в чат задачи.
// Поэтому: результат, если есть и он свежее; иначе последнее сообщение ЧЕЛОВЕКА в чате
// задачи (im.dialog.messages.get; системные «начал выполнять / изменил срок» — author_id 0).
// Грузится отдельным запросом после доски, только для видимых карточек: доску не тормозит.
//
// «Битрикс дёргать как можно меньше» (владелец 23.10, план Fable; миграция 253): комментарий хранится
// у нас (repeat_task_notes), деплои его не сбрасывают. В Битрикс за сообщениями чата идём, только если
//  • задачу ещё не читали, или
//  • задача изменилась в копии (sa.bitrix_task_current.changed_at новее, чем при чтении), или
//  • задача открыта и с прошлого чтения прошло 30 мин в рабочие часы МСК (8–21) — сообщение в чат
//    не всегда даёт ONTASKUPDATE (1 из 10, замер 23.10).
// Закрытые задачи без изменений не перечитываем вовсе. chatId — из событий задачи в копии (CHAT_ID в
// sa.bitrix_task_payload_raw), а где его нет — один раз из tasks.task.list, навсегда.
// Раньше: кэш 3 мин в памяти процесса → ~5 batch по 50 im.dialog.messages.get каждые 3 мин.
import { bx } from '@/lib/bitrix/notify';
import { analyticsDb, systemDb } from '@/lib/db/clients';
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

const OPEN_RECHECK_MS = 30 * 60_000;
const PER_CALL = 50;
const CLOSED_STATUSES = new Set([5, 7]); // 5 — завершена, 7 — отклонена
/** Выборки в полёте на процесс — параллельные запросы доски не дублируют batch. */
const g = globalThis as unknown as { __repeatTaskNotesInflight?: Map<number, Promise<void>> };
const inflight: Map<number, Promise<void>> = (g.__repeatTaskNotesInflight ??= new Map());
/** Битрикс ответил ошибкой — эти задачи 5 мин не трогаем (иначе каждый запрос доски повторял бы batch). */
const FAIL_PAUSE_MS = 5 * 60_000;
const gf = globalThis as unknown as { __repeatTaskNotesFail?: Map<number, number> };
const failedAt: Map<number, number> = (gf.__repeatTaskNotesFail ??= new Map());

const mskHour = (ms = Date.now()) => new Date(ms + 3 * 3600_000).getUTCHours();

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

/** chatId задач без него в нашей таблице: сначала из событий задачи в копии, остаток — tasks.task.list. */
async function resolveChats(taskIds: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (!taskIds.length) return out;
  const fromSa = await analyticsDb().query<{ task_id: string; chat_id: string | null }>(
    `SELECT DISTINCT ON (task_id) task_id::text, coalesce(payload#>>'{prev,CHAT_ID}', payload#>>'{task,CHAT_ID}', payload#>>'{task,chatId}') AS chat_id
       FROM sa.bitrix_task_payload_raw
      WHERE task_id = ANY($1::bigint[]) AND coalesce(payload#>>'{prev,CHAT_ID}', payload#>>'{task,CHAT_ID}', payload#>>'{task,chatId}') ~ '^[1-9][0-9]*$'
      ORDER BY task_id, id DESC`, [taskIds],
  ).catch(() => ({ rows: [] as { task_id: string; chat_id: string | null }[] }));
  for (const r of fromSa.rows) out.set(Number(r.task_id), Number(r.chat_id));
  const todo = taskIds.filter(id => !out.has(id));
  const cmd: Record<string, string> = {};
  for (let i = 0; i < todo.length; i += PER_CALL) {
    const ids = todo.slice(i, i + PER_CALL);
    cmd[`t${i}`] = `tasks.task.list?${ids.map(id => `filter[ID][]=${id}`).join('&')}&select[]=ID&select[]=CHAT_ID`;
  }
  const keys = Object.keys(cmd);
  for (let i = 0; i < keys.length; i += 50) {
    const res = await batch(Object.fromEntries(keys.slice(i, i + 50).map(k => [k, cmd[k]])));
    for (const v of Object.values(res)) {
      for (const t of ((v as { tasks?: { id: string; chatId?: string | null }[] })?.tasks ?? [])) {
        out.set(Number(t.id), t.chatId ? Number(t.chatId) : null);
      }
    }
  }
  for (const id of todo) if (!out.has(id)) out.set(id, null);
  return out;
}

interface ImMessage { id: number; author_id: number; date: string; text: string }
interface ImUser { id: number; name: string }
interface SaTask { task_id: string; changed_at: Date | null; status: number | null; results: { text?: string; createdAt?: string; createdBy?: number }[] | null }
interface Stored { task_id: string; chat_id: string | null; chat_checked: boolean; note: TaskNote | null; task_changed_at: Date | null; fetched_at: Date | null }

/** Прочитать из Битрикса последние сообщения чата для задач и записать в repeat_task_notes. */
async function refresh(tasks: SaTask[], stored: Map<number, Stored>): Promise<void> {
  const db = systemDb();
  const ids = tasks.map(t => Number(t.task_id));
  const needChat = ids.filter(id => !stored.get(id)?.chat_checked);
  const chats = new Map<number, number | null>(ids.map(id => [id, stored.get(id)?.chat_id ? Number(stored.get(id)!.chat_id) : null]));
  for (const [id, c] of await resolveChats(needChat)) chats.set(id, c);
  const fromChat = new Map<number, TaskNote | null>();
  const withChat = ids.filter(id => chats.get(id));
  for (let i = 0; i < withChat.length; i += 50) {
    const part = withChat.slice(i, i + 50);
    const res = await batch(Object.fromEntries(part.map(id => [`m${id}`, `im.dialog.messages.get?DIALOG_ID=chat${chats.get(id)}&LIMIT=20`])));
    for (const id of part) {
      const v = res[`m${id}`] as { messages?: ImMessage[]; users?: ImUser[] } | undefined;
      const human = (v?.messages ?? []).filter(m => m.author_id > 0 && stripBb(m.text ?? '').length > 0)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const user = human ? (v?.users ?? []).find(u => Number(u.id) === human.author_id) : undefined;
      fromChat.set(id, human ? {
        taskId: id, text: stripBb(human.text).slice(0, 2000), author: user?.name ?? null, authorId: String(human.author_id),
        at: new Date(human.date).toISOString(), isResult: false,
      } : null);
    }
  }
  for (const t of tasks) {
    const id = Number(t.task_id);
    await db.query(
      `INSERT INTO repeat_task_notes (task_id, chat_id, chat_checked, note, task_changed_at, fetched_at, refreshing_at)
       VALUES ($1, $2, true, $3::jsonb, $4, now(), NULL)
       ON CONFLICT (task_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, chat_checked = true, note = EXCLUDED.note,
         task_changed_at = EXCLUDED.task_changed_at, fetched_at = now(), refreshing_at = NULL`,
      [id, chats.get(id) ?? null, JSON.stringify(fromChat.get(id) ?? null), t.changed_at],
    );
  }
}

/** Последние комментарии по задачам (только задачи проекта «Повторные продажи»). */
export async function fetchTaskNotes(taskIds: number[]): Promise<Map<number, TaskNote>> {
  const ids = [...new Set(taskIds.filter(n => Number.isInteger(n) && n > 0))].slice(0, 400);
  const out = new Map<number, TaskNote>();
  if (!ids.length) return out;
  const db = systemDb();
  // Принадлежность проекту, изменение и формальный «Результат» — из копии Битрикса (без запросов в Битрикс).
  const sa = (await analyticsDb().query<SaTask>(
    `SELECT task_id::text, changed_at, status, results FROM sa.bitrix_task_current
      WHERE task_id = ANY($1::bigint[]) AND group_id = $2 AND NOT is_deleted`,
    [ids, REPEAT_PROJECT_GROUP_ID],
  )).rows;
  const stored = new Map((await db.query<Stored>(
    'SELECT task_id::text, chat_id::text, chat_checked, note, task_changed_at, fetched_at FROM repeat_task_notes WHERE task_id = ANY($1::bigint[])',
    [sa.map(t => t.task_id)],
  )).rows.map(r => [Number(r.task_id), r]));

  const now = Date.now();
  const workHours = mskHour(now) >= 8 && mskHour(now) < 21;
  const stale = sa.filter(t => {
    const id = Number(t.task_id);
    const s = stored.get(id);
    if (!s?.fetched_at) return true;
    if (t.changed_at && (!s.task_changed_at || new Date(t.changed_at).getTime() > new Date(s.task_changed_at).getTime())) return true;
    const closed = t.status !== null && CLOSED_STATUSES.has(Number(t.status));
    return !closed && workHours && now - new Date(s.fetched_at).getTime() > OPEN_RECHECK_MS;
  });
  // Ещё не выбираемые этим процессом; занятые — подождём их же выборку.
  const mine = stale.filter(t => !inflight.has(Number(t.task_id)) && now - (failedAt.get(Number(t.task_id)) ?? 0) > FAIL_PAUSE_MS);
  const waits = stale.map(t => inflight.get(Number(t.task_id))).filter((p): p is Promise<void> => !!p);
  if (mine.length) {
    const p = refresh(mine, stored).catch(e => {
      for (const t of mine) failedAt.set(Number(t.task_id), Date.now());
      if (failedAt.size > 5000) failedAt.clear();
      console.warn('[repeat-kanban] комментарии задач из Битрикса:', e instanceof Error ? e.message : e);
    });
    for (const t of mine) inflight.set(Number(t.task_id), p);
    waits.push(p.finally(() => { for (const t of mine) if (inflight.get(Number(t.task_id)) === p) inflight.delete(Number(t.task_id)); }));
  }
  if (waits.length) {
    await Promise.all(waits);
    const again = await db.query<Stored>(
      'SELECT task_id::text, chat_id::text, chat_checked, note, task_changed_at, fetched_at FROM repeat_task_notes WHERE task_id = ANY($1::bigint[])',
      [stale.map(t => t.task_id)],
    );
    for (const r of again.rows) stored.set(Number(r.task_id), r);
  }

  // Формальный «Результат» главнее, если он не старше последнего сообщения в чате.
  const results = new Map<number, TaskNote>();
  for (const x of sa) {
    const last = [...(x.results ?? [])].filter(y => y.text).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (last?.text && last.createdAt) {
      results.set(Number(x.task_id), {
        taskId: Number(x.task_id), text: stripBb(last.text), author: null,
        authorId: last.createdBy ? String(last.createdBy) : null, at: new Date(last.createdAt).toISOString(), isResult: true,
      });
    }
  }
  const needNames = [...results.values()].map(n => n.authorId).filter((x): x is string => !!x);
  const names = needNames.length ? new Map((await analyticsDb().query<{ id: string; name: string }>(
    `SELECT manager_bitrix_user_id::text AS id, manager_name AS name FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::text = ANY($1::text[])`,
    [needNames],
  ).catch(() => ({ rows: [] as { id: string; name: string }[] }))).rows.map(x => [x.id, x.name])) : new Map<string, string>();
  for (const t of sa) {
    const id = Number(t.task_id);
    const a = results.get(id), b = stored.get(id)?.note ?? undefined;
    const note = a && (!b || a.at >= b.at) ? { ...a, author: names.get(a.authorId ?? '') ?? null } : b ?? a ?? null;
    if (note) out.set(id, { ...note, text: note.text.length > 600 ? `${note.text.slice(0, 600)}…` : note.text });
  }
  return out;
}
