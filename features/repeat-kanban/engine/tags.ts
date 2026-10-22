// Теги заказчиков (миграция 245, владелец 22.10, правка №3): базовые — для всех и неудаляемые,
// личные — у каждого аккаунта свои (видит и ставит только владелец). Цвет — из «Основной палитры».
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { isTagColor, type TagColor, type TagDef } from './tagColors';

export class TagError extends Error {}
const MAX_OWN = 30;

interface DefRow { id: number; name: string; color: string; owner_user_id: string | null }
const toDef = (r: DefRow): TagDef => ({ id: r.id, name: r.name, color: isTagColor(r.color) ? r.color : 'gray', system: r.owner_user_id === null });

/** Теги, которые видит пользователь: базовые, потом свои (по имени). */
export async function fetchVisibleTagDefs(userId: string): Promise<TagDef[]> {
  const r = await systemDb().query<DefRow>(
    `SELECT id, name, color, owner_user_id FROM customer_tag_defs
      WHERE archived_at IS NULL AND (owner_user_id IS NULL OR owner_user_id = $1)
      ORDER BY (owner_user_id IS NOT NULL), position, lower(name)`, [userId],
  );
  return r.rows.map(toDef);
}

/** Заказчик → id видимых пользователю тегов. До миграции — пусто (доска не падает). */
export async function fetchCustomerTags(keys: string[], userId: string): Promise<{ defs: TagDef[]; byKey: Map<string, number[]> }> {
  try {
    const defs = await fetchVisibleTagDefs(userId);
    if (!keys.length || !defs.length) return { defs, byKey: new Map() };
    const r = await systemDb().query<{ client_key: string; tag_id: number }>(
      `SELECT client_key, tag_id FROM customer_tags WHERE client_key = ANY($1::text[]) AND tag_id = ANY($2::int[])`,
      [keys, defs.map(d => d.id)],
    );
    const byKey = new Map<string, number[]>();
    for (const x of r.rows) byKey.set(x.client_key, [...(byKey.get(x.client_key) ?? []), x.tag_id]);
    return { defs, byKey };
  } catch (e) {
    console.warn('[repeat-kanban tags]', e instanceof Error ? e.message : e);
    return { defs: [], byKey: new Map() };
  }
}

const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 40) : '');
/** Дубль среди видимых пользователю тегов — сравнение в JS: lower() в БД зависит от локали
 *  (в C-локали кириллицу не понижает — проверено на временной базе). */
async function assertUnique(userId: string, name: string, exceptId: number | null) {
  const low = name.toLocaleLowerCase('ru');
  const hit = (await fetchVisibleTagDefs(userId)).find(d => d.id !== exceptId && d.name.toLocaleLowerCase('ru') === low);
  if (hit) throw new TagError(`Тег «${hit.name}» уже есть`);
}

export async function createTag(session: SessionUser, name: unknown, color: unknown): Promise<TagDef> {
  const n = cleanName(name);
  if (!n) throw new TagError('Напишите название тега');
  const c: TagColor = isTagColor(color) ? color : 'gray';
  const db = systemDb();
  const cnt = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM customer_tag_defs WHERE owner_user_id = $1 AND archived_at IS NULL`, [session.id]);
  if (Number(cnt.rows[0]?.n ?? 0) >= MAX_OWN) throw new TagError(`Не больше ${MAX_OWN} своих тегов`);
  await assertUnique(session.id, n, null);
  const r = await db.query<DefRow>(
    `INSERT INTO customer_tag_defs (name, color, owner_user_id) VALUES ($1, $2, $3) RETURNING id, name, color, owner_user_id`, [n, c, session.id]);
  return toDef(r.rows[0]);
}

/** Переименовать / перекрасить / удалить (в архив) — только свой тег. */
export async function updateTag(session: SessionUser, id: number, patch: { name?: unknown; color?: unknown; remove?: boolean }): Promise<void> {
  const db = systemDb();
  const own = await db.query(`SELECT 1 FROM customer_tag_defs WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL`, [id, session.id]);
  if (!own.rowCount) throw new TagError('Это базовый тег или не ваш — его нельзя менять');
  if (patch.remove) { await db.query(`UPDATE customer_tag_defs SET archived_at = now() WHERE id = $1`, [id]); return; }
  const n = patch.name !== undefined ? cleanName(patch.name) : null;
  if (patch.name !== undefined && !n) throw new TagError('Напишите название тега');
  if (n) await assertUnique(session.id, n, id);
  await db.query(`UPDATE customer_tag_defs SET name = coalesce($2, name), color = coalesce($3, color) WHERE id = $1`,
    [id, n, isTagColor(patch.color) ? patch.color : null]);
}

/** Теги заказчика — заменить набор ВИДИМЫХ пользователю тегов (чужие личные не трогаются). */
export async function setCustomerTags(session: SessionUser, clientKey: string, tagIds: unknown): Promise<number[]> {
  const visible = await fetchVisibleTagDefs(session.id);
  const allowed = new Set(visible.map(d => d.id));
  const want = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(Number).filter(id => allowed.has(id)))];
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM customer_tags WHERE client_key = $1 AND tag_id = ANY($2::int[]) AND NOT (tag_id = ANY($3::int[]))`,
      [clientKey, [...allowed], want]);
    if (want.length) {
      await client.query(
        `INSERT INTO customer_tags (client_key, tag_id, created_by, created_by_user_id)
         SELECT $1, t, $3, $4 FROM unnest($2::int[]) AS t ON CONFLICT DO NOTHING`,
        [clientKey, want, session.displayName, session.id]);
    }
    await client.query('COMMIT');
    return want;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
