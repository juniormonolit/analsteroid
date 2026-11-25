// Индикатор «новое» на карточках (владелец 25.11: «при наличии новых действий или сообщений в задаче или сделке —
// оповещения на карточке, чтобы работающий с канбаном сразу видел, что есть новенькое»; спецификация Fable, раздел 5).
//
// Новое для смотрящего — то, что случилось после его прошлого открытия карточки (big_task_seen), и не им самим:
//  • chat    — последнее сообщение ЧЕЛОВЕКА в чате задачи, автор не смотрящий (кэш big_task_lastmsg);
//  • related — связанная задача (логист, снабжение) менялась (changedAt из снимка);
//  • control — задача ждёт контроля и менялась;
//  • stage   — сменилась стадия сделки (deal.stageAt).
// Точка отсчёта: нет записи по задаче — момент включения фичи у пользователя (task_id = 0), иначе при первом входе
// загорелась бы вся доска. Свои действия через канбан отмечают карточку просмотренной (action-роут → markSeen).
//
// Последнее сообщение чата: ACTIVITY_DATE задачи двигают и служебные «задача просрочена» (сверено 25.11 на 179969/180931),
// поэтому в Битрикс за чатом идём только для задач, у которых ACTIVITY_DATE сдвинулся с прошлого чтения, — batch по 50
// im.dialog.messages.get, в фоне (доска не ждёт), не чаще раза в минуту на процесс. Сбой БД/Битрикса — без индикатора.
import { systemDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';
import { taskWebhook } from '@/features/repeat-kanban/engine/createDeal';
import type { BigFresh, BigFreshKind, BigTaskCard } from './types';

const RECENT_DONE_MS = 3 * 86_400_000;
const MIN_GAP_MS = 60_000;
const g = globalThis as unknown as { __bigFresh?: { running: Promise<void> | null; lastRun: number } };
const state = (g.__bigFresh ??= { running: null, lastRun: 0 });

interface LastMsg { chat_id: string | null; activity_at: Date | null; msg_at: Date | null; msg_author: string | null; msg_author_name: string | null }
const g2 = globalThis as unknown as { __bigLastMsg?: { at: number; map: Map<number, LastMsg> } };

async function loadLastMsgs(): Promise<Map<number, LastMsg>> {
  const c = g2.__bigLastMsg;
  if (c && Date.now() - c.at < 30_000) return c.map;
  const r = await systemDb().query<LastMsg & { task_id: string }>('SELECT task_id::text, chat_id::text, activity_at, msg_at, msg_author, msg_author_name FROM big_task_lastmsg');
  const map = new Map(r.rows.map(x => [Number(x.task_id), x]));
  g2.__bigLastMsg = { at: Date.now(), map };
  return map;
}

interface ImMessage { id: number; author_id: number; date: string }
interface ImUser { id: number; name: string }

/** Перечитать последнее сообщение человека у задач со сдвинувшимся ACTIVITY_DATE. Фоном, с защитой от параллельных запусков. */
export function refreshLastMessages(cards: BigTaskCard[]): void {
  if (state.running || Date.now() - state.lastRun < MIN_GAP_MS) return;
  state.lastRun = Date.now();
  state.running = (async () => {
    const stored = await loadLastMsgs();
    const now = Date.now();
    const todo = cards.filter(c => c.chatId && c.activityAt
      && (c.state !== 'done' || (c.closedAt && now - Date.parse(c.closedAt) < RECENT_DONE_MS))
      && (() => { const s = stored.get(c.id); return !s?.activity_at || new Date(s.activity_at).toISOString() !== c.activityAt; })());
    for (let i = 0; i < todo.length; i += 50) {
      const part = todo.slice(i, i + 50);
      const cmd = Object.fromEntries(part.map(c => [`m${c.id}`, `im.dialog.messages.get?DIALOG_ID=chat${c.chatId}&LIMIT=20`]));
      const res = await bx(taskWebhook(), 'batch', { halt: 0, cmd }) as { result?: { result?: Record<string, { messages?: ImMessage[]; users?: ImUser[] }> } };
      const out = res.result?.result ?? {};
      for (const c of part) {
        const v = out[`m${c.id}`];
        if (!v) continue; // ошибка по задаче — попробуем в следующий раз
        const human = (v.messages ?? []).filter(m => m.author_id > 0).sort((a, b) => b.date.localeCompare(a.date))[0];
        const name = human ? (v.users ?? []).find(u => Number(u.id) === human.author_id)?.name ?? null : null;
        await systemDb().query(
          `INSERT INTO big_task_lastmsg (task_id, chat_id, activity_at, msg_at, msg_author, msg_author_name, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (task_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, activity_at = EXCLUDED.activity_at, msg_at = EXCLUDED.msg_at,
             msg_author = EXCLUDED.msg_author, msg_author_name = EXCLUDED.msg_author_name, fetched_at = now()`,
          [c.id, c.chatId, c.activityAt, human ? new Date(human.date).toISOString() : null, human ? String(human.author_id) : null, name],
        );
        stored.set(c.id, { chat_id: String(c.chatId), activity_at: new Date(c.activityAt!), msg_at: human ? new Date(human.date) : null, msg_author: human ? String(human.author_id) : null, msg_author_name: name });
      }
    }
    if (todo.length) console.info(`[big-deals fresh] чаты перечитаны: ${todo.length}`);
  })().catch(e => { console.warn('[big-deals fresh]', e instanceof Error ? e.message : e); }).finally(() => { state.running = null; });
}

const ORDER: BigFreshKind[] = ['chat', 'related', 'control', 'stage'];

/** Карточки с полем fresh для смотрящего. userKey — id пользователя Монолитики, viewerBx — его Bitrix id. */
export async function withFresh(cards: BigTaskCard[], userKey: string, viewerBx: string | null): Promise<BigTaskCard[]> {
  try {
    const db = systemDb();
    const [seenRows, last] = await Promise.all([
      db.query<{ task_id: string; seen_at: Date }>('SELECT task_id::text, seen_at FROM big_task_seen WHERE user_id = $1', [userKey]),
      loadLastMsgs(),
    ]);
    const seen = new Map(seenRows.rows.map(r => [Number(r.task_id), new Date(r.seen_at).toISOString()]));
    let base = seen.get(0);
    if (!base) {
      await db.query('INSERT INTO big_task_seen (user_id, task_id, seen_at) VALUES ($1, 0, now()) ON CONFLICT DO NOTHING', [userKey]);
      return cards; // первый вход — точка отсчёта, нового нет
    }
    return cards.map(c => {
      const since = seen.get(c.id) ?? base!;
      const kinds = new Set<BigFreshKind>();
      const m = last.get(c.id);
      let chatAuthor: string | null = null;
      if (m?.msg_at && new Date(m.msg_at).toISOString() > since && m.msg_author !== viewerBx) { kinds.add('chat'); chatAuthor = m.msg_author_name; }
      if (c.related.some(r => r.changedAt && r.changedAt > since)) kinds.add('related');
      if (c.state === 'control' && c.changedAt && c.changedAt > since) kinds.add('control');
      if (c.deal?.stageAt && c.deal.stageAt > since) kinds.add('stage');
      if (!kinds.size) return c;
      const fresh: BigFresh = { kinds: ORDER.filter(k => kinds.has(k)), chatAuthor, since };
      return { ...c, fresh };
    });
  } catch (e) {
    console.warn('[big-deals fresh] без индикатора:', e instanceof Error ? e.message : e);
    return cards;
  }
}

/** Отметить карточку просмотренной; вернуть прошлую отметку (для разделителя «новое» в ленте). */
export async function markSeen(userKey: string, taskId: number): Promise<string | null> {
  const db = systemDb();
  const r = await db.query<{ seen_at: Date | null }>(
    `WITH prev AS (SELECT seen_at FROM big_task_seen WHERE user_id = $1 AND task_id = $2),
          base AS (SELECT seen_at FROM big_task_seen WHERE user_id = $1 AND task_id = 0),
          up AS (INSERT INTO big_task_seen (user_id, task_id, seen_at) VALUES ($1, $2, now())
                 ON CONFLICT (user_id, task_id) DO UPDATE SET seen_at = now())
     SELECT coalesce((SELECT seen_at FROM prev), (SELECT seen_at FROM base)) AS seen_at`,
    [userKey, taskId],
  );
  const v = r.rows[0]?.seen_at;
  return v ? new Date(v).toISOString() : null;
}
