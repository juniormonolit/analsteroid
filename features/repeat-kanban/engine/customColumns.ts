// «Свои колонки» во вкладке «Сегодня» (владелец 10.11; проект — Fable; миграция 262). РОП задаёт гипотезу набором
// условий («LTV > 2 млн, от 2 отгрузок, сделка в работе») — колонка в «Сегодня» показывает подходящих заказчиков.
// Условия считаются по готовой карточке доски (без дозагрузок): LTV, число отгрузок, где заказчик сейчас (колонка
// доски или группа), задачи, тип клиента, теги, последняя сделка. Поверх — фильтры доски, как у всех колонок «Сегодня».
// Тревога (опционально): «нет звонка N дней» (только у карточек со сделкой), «задача просрочена», «нет задачи».
// Метрика гипотезы: история членства (members) → «дошли до отгрузки за 30 дней: колонка против остальных».
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { COLUMNS, SHIP_BUCKETS, shipBucket, type ColumnGroup } from './config';

export class CustomColumnError extends Error {}
export const MAX_OWN_COLUMNS = 5;

export type CustomTask = 'none' | 'unread' | 'work' | 'overdue' | 'control' | 'done';
export interface CustomFilters {
  ltvMin?: number; ltvMax?: number;
  ships?: string[];
  /** Колонки доски (ColumnKey) и группы `g:pool` / `g:touch` / `g:stage` / `g:review`. */
  stage?: string[];
  tasks?: CustomTask[];
  /** Тип клиента (profileType) или `none` — не указан. */
  type?: string[];
  tags?: number[];
  outcome?: 'won' | 'lost';
}
export interface CustomAlert { noCallDays?: number; overdue?: boolean; noTask?: boolean }
export interface CustomColumn {
  id: number; ownerUserId: string; ownerName: string | null; name: string; shared: boolean;
  filters: CustomFilters; alert: CustomAlert | null; createdAt: string; own: boolean;
  /** Общая колонка-пример (миграция 262, is_example): правит РОП и выше, удалить нельзя. */
  example: boolean;
}

const TASKS: CustomTask[] = ['none', 'unread', 'work', 'overdue', 'control', 'done'];
const GROUPS: ColumnGroup[] = ['pool', 'touch', 'stage', 'review'];
const COL_KEYS = new Set<string>(COLUMNS.map(c => c.key));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e12 ? Math.round(v) : undefined);
const strs = (v: unknown, ok: (s: string) => boolean, max = 50) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ok(x)))].slice(0, max) : []);

/** Серверная проверка условий; пустой набор — ошибка (колонка «все подряд» бессмысленна). */
export function cleanFilters(raw: unknown): CustomFilters {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f: CustomFilters = {};
  const lo = num(r.ltvMin), hi = num(r.ltvMax);
  if (lo !== undefined && lo > 0) f.ltvMin = lo;
  if (hi !== undefined && hi > 0) f.ltvMax = hi;
  const ships = strs(r.ships, s => SHIP_BUCKETS.some(b => b.value === s));
  if (ships.length) f.ships = ships;
  const stage = strs(r.stage, s => COL_KEYS.has(s) || GROUPS.some(g => `g:${g}` === s));
  if (stage.length) f.stage = stage;
  const tasks = strs(r.tasks, s => (TASKS as string[]).includes(s)) as CustomTask[];
  if (tasks.length) f.tasks = tasks;
  const type = strs(r.type, s => /^[a-z_]{2,30}$/.test(s));
  if (type.length) f.type = type;
  if (Array.isArray(r.tags)) { const t = [...new Set(r.tags.filter((x): x is number => Number.isInteger(x) && x > 0))].slice(0, 30); if (t.length) f.tags = t; }
  if (r.outcome === 'won' || r.outcome === 'lost') f.outcome = r.outcome;
  if (!Object.keys(f).length) throw new CustomColumnError('Задайте хотя бы одно условие');
  return f;
}

export function cleanAlert(raw: unknown): CustomAlert | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const a: CustomAlert = {};
  const d = num(r.noCallDays);
  if (d !== undefined && d >= 1 && d <= 90) a.noCallDays = d;
  if (r.overdue === true) a.overdue = true;
  if (r.noTask === true) a.noTask = true;
  return Object.keys(a).length ? a : null;
}

/** Карточка — минимум полей, нужных для условий (тип — чтобы не тянуть KanbanCard и не завести цикл импортов). */
export interface MatchCard {
  clientKey: string; column: string; sumDelivered: number; purchases: number; profileType: string | null; tags: number[];
  lastOutcome: 'won' | 'lost'; lastDeliveredAt: string | null;
  deal: { createdAt: string } | null; calls: { at: string }[]; attempts: { startAt: string; days: string[] } | null;
}
const groupOf = new Map<string, ColumnGroup>(COLUMNS.map(c => [c.key, c.group]));

export function matchCustom(c: MatchCard, f: CustomFilters, task: CustomTask): boolean {
  if (f.ltvMin !== undefined && c.sumDelivered < f.ltvMin) return false;
  if (f.ltvMax !== undefined && c.sumDelivered > f.ltvMax) return false;
  if (f.ships && !f.ships.includes(shipBucket(c.purchases))) return false;
  if (f.stage && !f.stage.some(s => s === c.column || s === `g:${groupOf.get(c.column)}`)) return false;
  if (f.tasks && !f.tasks.includes(task)) return false;
  if (f.type && !f.type.includes(c.profileType ?? 'none')) return false;
  if (f.tags && !f.tags.some(t => c.tags.includes(t))) return false;
  if (f.outcome && f.outcome !== c.lastOutcome) return false;
  return true;
}

/** Причина тревоги или null. «Нет звонка» — только у карточек со сделкой (у пула звонков в карточке нет). */
export function alertOf(c: MatchCard, a: CustomAlert | null, task: CustomTask, now = Date.now()): string | null {
  if (!a) return null;
  if (a.overdue && task === 'overdue') return 'задача просрочена';
  if (a.noTask && task === 'none') return 'нет задачи';
  if (a.noCallDays && c.deal) {
    const last = c.calls[0]?.at ?? c.attempts?.days[c.attempts.days.length - 1] ?? c.attempts?.startAt ?? c.deal.createdAt;
    const days = Math.floor((now - new Date(last).getTime()) / 86_400_000);
    if (days >= a.noCallDays) return `нет звонка ${days} дн.`;
  }
  return null;
}

interface Row { id: string; owner_user_id: string; owner_name: string | null; name: string; shared: boolean; filters: CustomFilters; alert: CustomAlert | null; created_at: Date; is_example: boolean }
const toCol = (r: Row, userId: string): CustomColumn => ({
  id: Number(r.id), ownerUserId: r.owner_user_id, ownerName: r.owner_name, name: r.name, shared: r.shared,
  filters: r.filters ?? {}, alert: r.alert, createdAt: new Date(r.created_at).toISOString(), own: r.owner_user_id === userId,
  example: !!r.is_example,
});

/** Свои + общие чужие (кроме скрытых у себя). До миграции — пусто. */
export async function fetchVisibleColumns(userId: string, hidden: number[] = []): Promise<CustomColumn[]> {
  try {
    const r = await systemDb().query<Row>(
      `SELECT id::text, owner_user_id, owner_name, name, shared, filters, alert, created_at, is_example FROM repeat_today_columns
        WHERE archived_at IS NULL AND (owner_user_id = $1 OR ((shared OR is_example) AND NOT (id = ANY($2::bigint[]))))
        ORDER BY NOT is_example, (owner_user_id <> $1), position, id`, [userId, hidden]);
    return r.rows.map(x => toCol(x, userId));
  } catch (e) {
    console.warn('[repeat-kanban custom columns]', e instanceof Error ? e.message : e);
    return [];
  }
}

const cleanName = (v: unknown) => {
  const n = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
  if (n.length < 2) throw new CustomColumnError('Назовите колонку');
  return n;
};

export async function createColumn(session: SessionUser, body: Record<string, unknown>): Promise<CustomColumn> {
  const db = systemDb();
  const cnt = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM repeat_today_columns WHERE owner_user_id = $1 AND archived_at IS NULL AND NOT is_example`, [session.id]);
  if (Number(cnt.rows[0]?.n ?? 0) >= MAX_OWN_COLUMNS) throw new CustomColumnError(`Не больше ${MAX_OWN_COLUMNS} своих колонок — удалите ненужную`);
  const r = await db.query<Row>(
    `INSERT INTO repeat_today_columns (owner_user_id, owner_name, name, shared, filters, alert, position)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, (SELECT coalesce(max(position), 0) + 1 FROM repeat_today_columns WHERE owner_user_id = $1))
     RETURNING id::text, owner_user_id, owner_name, name, shared, filters, alert, created_at`,
    [session.id, session.displayName, cleanName(body.name), body.shared === true, JSON.stringify(cleanFilters(body.filters)), JSON.stringify(cleanAlert(body.alert))]);
  return toCol(r.rows[0], session.id);
}

/** Изменить — владелец; колонку-пример — РОП и выше (canManage), без смены «общая/личная». Условия поменялись —
 *  история членства обнуляется (метрика считается заново). */
export async function updateColumn(session: SessionUser, id: number, body: Record<string, unknown>, canManage = false): Promise<void> {
  const db = systemDb();
  const cur = await db.query<{ filters: CustomFilters; is_example: boolean }>(
    `SELECT filters, is_example FROM repeat_today_columns WHERE id = $1 AND archived_at IS NULL AND (owner_user_id = $2 OR (is_example AND $3))`,
    [id, session.id, canManage]);
  if (!cur.rows[0]) throw new CustomColumnError('Колонка не найдена или не ваша');
  if (cur.rows[0].is_example) delete body.shared;
  const sets: string[] = [], vals: unknown[] = [id];
  const add = (sql: string, v: unknown) => { vals.push(v); sets.push(`${sql} = $${vals.length}`); };
  if (body.name !== undefined) add('name', cleanName(body.name));
  if (typeof body.shared === 'boolean') add('shared', body.shared);
  let filtersChanged = false;
  if (body.filters !== undefined) {
    const f = cleanFilters(body.filters);
    filtersChanged = JSON.stringify(f) !== JSON.stringify(cur.rows[0].filters);
    vals.push(JSON.stringify(f)); sets.push(`filters = $${vals.length}::jsonb`);
  }
  if (body.alert !== undefined) { vals.push(JSON.stringify(cleanAlert(body.alert))); sets.push(`alert = $${vals.length}::jsonb`); }
  if (!sets.length) return;
  await db.query(`UPDATE repeat_today_columns SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  if (filtersChanged) await db.query(`DELETE FROM repeat_today_column_members WHERE column_id = $1`, [id]);
}

export async function deleteColumn(session: SessionUser, id: number): Promise<void> {
  const r = await systemDb().query(`UPDATE repeat_today_columns SET archived_at = now() WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL AND NOT is_example`, [id, session.id]);
  if (!r.rowCount) throw new CustomColumnError('Колонка не найдена или не ваша');
}

// ── История членства и метрика гипотезы ─────────────────────────────────────────────────────────────────────────────
const recorded = new Map<number, number>();
const RECORD_EVERY_MS = 60 * 60_000;
const todayMsk = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

/** Отметить, кто сейчас в колонке (не чаще раза в час на колонку — доска перестраивается каждую минуту). */
export async function recordMembers(columnId: number, keys: string[]): Promise<void> {
  const at = recorded.get(columnId) ?? 0;
  if (Date.now() - at < RECORD_EVERY_MS || !keys.length) return;
  recorded.set(columnId, Date.now());
  const d = todayMsk();
  await systemDb().query(
    `INSERT INTO repeat_today_column_members (column_id, client_key, first_seen, last_seen)
     SELECT $1, k, $3::date, $3::date FROM unnest($2::text[]) AS k
     ON CONFLICT (column_id, client_key) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
    [columnId, keys.slice(0, 5000), d],
  ).catch(e => { recorded.delete(columnId); console.warn('[repeat-kanban custom members]', e instanceof Error ? e.message : e); });
}

export interface HypothesisMetric {
  /** Пока колонке меньше 7 дней или в ней меньше 20 заказчиков — «копим данные». */
  ready: boolean; days: number;
  inN: number; inShipped: number; restN: number; restShipped: number;
}

/** Скользящие 30 дней: колонка — кто был в ней (last_seen ≥ −30) и отгрузился после попадания; остальные — прочие
 *  заказчики той же доски (кроме брака и скрытых) с отгрузкой за 30 дней. Сравнение, не доказательство. */
export async function hypothesisMetric(col: CustomColumn, cards: { clientKey: string; column: string; lastDeliveredAt: string | null }[]): Promise<HypothesisMetric | null> {
  try {
    const r = await systemDb().query<{ client_key: string; first_seen: string }>(
      `SELECT client_key, to_char(first_seen, 'YYYY-MM-DD') AS first_seen FROM repeat_today_column_members
        WHERE column_id = $1 AND last_seen >= (now() AT TIME ZONE 'Europe/Moscow')::date - 30`, [col.id]);
    const since = Date.now() - 30 * 86_400_000;
    const members = new Map(r.rows.map(x => [x.client_key, x.first_seen]));
    let inN = 0, inShipped = 0, restN = 0, restShipped = 0;
    for (const c of cards) {
      const shippedAt = c.lastDeliveredAt ? new Date(c.lastDeliveredAt).getTime() : 0;
      const first = members.get(c.clientKey);
      if (first) {
        inN++;
        if (shippedAt >= since && shippedAt > new Date(`${first}T00:00:00+03:00`).getTime()) inShipped++;
      } else if (c.column !== 'brak' && c.column !== 'hidden') {
        restN++;
        if (shippedAt >= since) restShipped++;
      }
    }
    const days = Math.floor((Date.now() - new Date(col.createdAt).getTime()) / 86_400_000);
    return { ready: days >= 7 && inN >= 20, days, inN, inShipped, restN, restShipped };
  } catch {
    return null;
  }
}
