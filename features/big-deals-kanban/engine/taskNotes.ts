// Комментарий к карточке задачи (Осипов 25.11: «поле комментарий в карточке, и чтоб выводилось на карточке в канбане»).
// Таблица big_task_notes (миграция 293): одна заметка на задачу, общая для всех, кто видит задачу; пишет РОП.
// В Битрикс не уходит — для вопросов менеджеру есть чат задачи. Таблица маленькая (сотни строк) — читаем целиком,
// кэш в памяти процесса 30 с. Сбой БД (пул таймаутит) доску не роняет: карточки просто без комментариев.
import { systemDb } from '@/lib/db/clients';
import type { BigTaskCard, BigTaskNote } from './types';

export const NOTE_MAX = 2000;
const TTL = 30_000;
const g = globalThis as unknown as { __bigTaskNotes?: { at: number; map: Map<number, BigTaskNote> } };

async function loadAll(): Promise<Map<number, BigTaskNote>> {
  const c = g.__bigTaskNotes;
  if (c && Date.now() - c.at < TTL) return c.map;
  const r = await systemDb().query<{ task_id: string; text: string; author_name: string | null; updated_at: Date }>(
    'SELECT task_id::text, text, author_name, updated_at FROM big_task_notes',
  );
  const map = new Map(r.rows.map(x => [Number(x.task_id), { text: x.text, author: x.author_name, at: new Date(x.updated_at).toISOString() }]));
  g.__bigTaskNotes = { at: Date.now(), map };
  return map;
}

/** Карточки с комментариями. Без БД — как есть (и в лог). */
export async function withNotes(cards: BigTaskCard[]): Promise<BigTaskCard[]> {
  const map = await loadAll().catch(e => { console.warn('[big-deals] комментарии карточек:', e instanceof Error ? e.message : e); return null; });
  if (!map?.size) return cards;
  return cards.map(c => { const n = map.get(c.id); return n ? { ...c, note: n } : c; });
}

export async function withNote(card: BigTaskCard | null): Promise<BigTaskCard | null> {
  return card ? (await withNotes([card]))[0] : null;
}

/** Сохранить (пустой текст — удалить). Возвращает заметку или null. */
export async function saveNote(taskId: number, text: string, author: { id: string | null; name: string | null }): Promise<BigTaskNote | null> {
  const t = text.replace(/\r\n/g, '\n').trim().slice(0, NOTE_MAX);
  const db = systemDb();
  let note: BigTaskNote | null = null;
  if (!t) await db.query('DELETE FROM big_task_notes WHERE task_id = $1', [taskId]);
  else {
    const r = await db.query<{ updated_at: Date }>(
      `INSERT INTO big_task_notes (task_id, text, author_id, author_name, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (task_id) DO UPDATE SET text = EXCLUDED.text, author_id = EXCLUDED.author_id, author_name = EXCLUDED.author_name, updated_at = now()
       RETURNING updated_at`,
      [taskId, t, author.id, author.name],
    );
    note = { text: t, author: author.name, at: new Date(r.rows[0].updated_at).toISOString() };
  }
  const c = g.__bigTaskNotes;
  if (c) { if (note) c.map.set(taskId, note); else c.map.delete(taskId); }
  return note;
}
