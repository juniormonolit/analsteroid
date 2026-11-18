// Свои колонки «Сегодня» канбана больших чеков (как в повторке, но без миграции): набор условий BigFilters,
// хранится в users.ui_prefs.bigDealsColumns (массив BigCustomColumn), до MAX_COLUMNS на пользователя.
import { randomUUID } from 'node:crypto';
import { systemDb } from '@/lib/db/clients';
import type { BigCustomColumn, BigFilters } from './types';
import { filtersEmpty, normalizeFilters } from './filters';

export class BigColumnError extends Error {}
export const MAX_COLUMNS = 5;

/** Проверка условий на сервере: мусор отбрасывается; ничего не осталось — ошибка (колонка «все подряд» бессмысленна). */
export function cleanColumnFilters(raw: unknown): BigFilters {
  const f = normalizeFilters(raw);
  if (filtersEmpty(f)) throw new BigColumnError('Задайте хотя бы одно условие');
  return f;
}

const cleanName = (v: unknown) => {
  const n = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
  if (n.length < 2) throw new BigColumnError('Назовите колонку');
  return n;
};

function parseStored(v: unknown): BigCustomColumn[] {
  if (!Array.isArray(v)) return [];
  const out: BigCustomColumn[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    const filters = normalizeFilters(r.filters);
    if (filtersEmpty(filters)) continue;
    out.push({ id: r.id, name: r.name, filters, createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString() });
  }
  return out.slice(0, MAX_COLUMNS);
}

/** Колонки пользователя (users.id). БД недоступна — пусто (доска не падает). */
export async function listColumns(userId: string): Promise<BigCustomColumn[]> {
  try {
    const r = await systemDb().query<{ c: unknown }>(`SELECT ui_prefs->'bigDealsColumns' AS c FROM users WHERE id = $1`, [userId]);
    return parseStored(r.rows[0]?.c);
  } catch (e) {
    console.warn('[big-deals custom columns]', e instanceof Error ? e.message : e);
    return [];
  }
}

async function save(userId: string, cols: BigCustomColumn[]): Promise<void> {
  await systemDb().query(
    `UPDATE users SET ui_prefs = jsonb_set(COALESCE(ui_prefs, '{}'::jsonb), '{bigDealsColumns}', $2::jsonb) WHERE id = $1`,
    [userId, JSON.stringify(cols)]);
}

export async function createColumn(userId: string, body: Record<string, unknown>): Promise<BigCustomColumn> {
  const name = cleanName(body.name);
  const filters = cleanColumnFilters(body.filters);
  const cols = await listColumns(userId);
  if (cols.length >= MAX_COLUMNS) throw new BigColumnError(`Не больше ${MAX_COLUMNS} своих колонок — удалите ненужную`);
  const col: BigCustomColumn = { id: randomUUID().replace(/-/g, '').slice(0, 10), name, filters, createdAt: new Date().toISOString() };
  await save(userId, [...cols, col]);
  return col;
}

export async function updateColumn(userId: string, id: string, body: Record<string, unknown>): Promise<BigCustomColumn> {
  const cols = await listColumns(userId);
  const i = cols.findIndex(c => c.id === id);
  if (i < 0) throw new BigColumnError('Колонка не найдена');
  const next = { ...cols[i] };
  if (body.name !== undefined) next.name = cleanName(body.name);
  if (body.filters !== undefined) next.filters = cleanColumnFilters(body.filters);
  cols[i] = next;
  await save(userId, cols);
  return next;
}

export async function deleteColumn(userId: string, id: string): Promise<void> {
  const cols = await listColumns(userId);
  const left = cols.filter(c => c.id !== id);
  if (left.length === cols.length) throw new BigColumnError('Колонка не найдена');
  await save(userId, left);
}
