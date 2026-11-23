// Задачник: конструктор шаблонов рекомендаций (правки собрания 23.11, TASKER_FEEDBACK_2026-11-23 п.4).
// Руководители пишут свои пошаговые инструкции на каждый показатель: несколько вариантов, ссылки, картинки,
// сортировка, архив (active = false). Миграция 280 — авторство и хранилище картинок.
import { systemDb } from '@/lib/db/clients';
import { hasPerm } from '@/lib/auth/perms';
import type { SessionUser } from '@/lib/auth/session';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import type { TaskerTemplateFull, TaskerTemplateSaveRequest } from '../types';
import { TaskerError, appBaseUrl } from './config';

export const TEMPLATE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TEMPLATE_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const TITLE_MAX = 120;
const BODY_MAX = 10_000;

/** Править шаблоны: «Администратор»/супер-админ — всегда; остальным — право action.tasker.templates. */
export function canManageTemplates(session: SessionUser): boolean {
  return hasFullManagerAccess(session) || hasPerm(session, 'action.tasker.templates');
}

interface Row {
  id: number; metric_id: string; title: string; body: string; sort_order: number; active: boolean;
  archived_at: Date | null; updated_at: Date | null; updated_by_name: string | null;
}

const toFull = (r: Row): TaskerTemplateFull => ({
  id: r.id, metricId: r.metric_id, title: r.title, body: r.body, sortOrder: r.sort_order, active: r.active,
  archivedAt: r.archived_at?.toISOString() ?? null, updatedAt: r.updated_at?.toISOString() ?? null,
  updatedBy: r.updated_by_name,
});

const SELECT_FULL = `
  SELECT t.id, t.metric_id, t.title, t.body, t.sort_order, t.active, t.archived_at, t.updated_at,
         COALESCE(u.display_name, t.updated_by) AS updated_by_name
    FROM tasker_templates t LEFT JOIN users u ON u.login = t.updated_by`;

/** Все шаблоны вместе с архивом — для редактора. */
export async function loadTemplatesFull(metricId?: string | null): Promise<TaskerTemplateFull[]> {
  const r = await systemDb().query<Row>(
    `${SELECT_FULL} WHERE ($1::text IS NULL OR t.metric_id = $1) ORDER BY t.metric_id, t.active DESC, t.sort_order, t.id`,
    [metricId ?? null],
  );
  return r.rows.map(toFull);
}

async function one(id: number): Promise<TaskerTemplateFull> {
  const r = await systemDb().query<Row>(`${SELECT_FULL} WHERE t.id = $1`, [id]);
  if (!r.rows[0]) throw new TaskerError('Шаблон не найден', 'bad_request', 404);
  return toFull(r.rows[0]);
}

function clean(req: TaskerTemplateSaveRequest) {
  const title = typeof req.title === 'string' ? req.title.trim().slice(0, TITLE_MAX) : undefined;
  const body = typeof req.body === 'string' ? req.body.replace(/\r\n/g, '\n').trim().slice(0, BODY_MAX) : undefined;
  const sortOrder = req.sortOrder !== undefined && Number.isFinite(Number(req.sortOrder)) ? Math.round(Number(req.sortOrder)) : undefined;
  return { title, body, sortOrder, active: typeof req.active === 'boolean' ? req.active : undefined };
}

/** Уникальность (metric_id, title) — с миграции 274: понятное сообщение вместо 500. */
function dupGuard(e: unknown): never {
  if ((e as { code?: string })?.code === '23505') throw new TaskerError('У этого показателя уже есть вариант с таким названием');
  throw e;
}

export async function createTemplate(session: SessionUser, req: TaskerTemplateSaveRequest): Promise<TaskerTemplateFull> {
  const metricId = typeof req.metricId === 'string' ? req.metricId.trim() : '';
  const c = clean(req);
  if (!metricId) throw new TaskerError('Не выбран показатель');
  if (!c.title) throw new TaskerError('Нужно название варианта');
  if (!c.body) throw new TaskerError('Нужен текст инструкции');
  const db = systemDb();
  const m = await db.query(`SELECT 1 FROM tasker_metrics WHERE id = $1`, [metricId]);
  if (!m.rowCount) throw new TaskerError('Показатель не найден в Задачнике');
  // Новый вариант — в конец списка показателя, если порядок не задан.
  const r = await db.query<{ id: number }>(
    `INSERT INTO tasker_templates (metric_id, title, body, sort_order, created_by, updated_by, updated_at)
     VALUES ($1, $2, $3,
             COALESCE($4, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM tasker_templates WHERE metric_id = $1)),
             $5, $5, now())
     RETURNING id`,
    [metricId, c.title, c.body, c.sortOrder ?? null, session.login],
  ).catch(dupGuard);
  return one(r.rows[0].id);
}

export async function updateTemplate(session: SessionUser, id: number, req: TaskerTemplateSaveRequest): Promise<TaskerTemplateFull> {
  const c = clean(req);
  if (c.title === '') throw new TaskerError('Нужно название варианта');
  if (c.body === '') throw new TaskerError('Нужен текст инструкции');
  const r = await systemDb().query(
    `UPDATE tasker_templates SET
        title       = COALESCE($2, title),
        body        = COALESCE($3, body),
        sort_order  = COALESCE($4, sort_order),
        active      = COALESCE($5, active),
        archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN NULL ELSE COALESCE(archived_at, now()) END,
        updated_by  = $6,
        updated_at  = now()
      WHERE id = $1`,
    [id, c.title ?? null, c.body ?? null, c.sortOrder ?? null, c.active ?? null, session.login],
  ).catch(dupGuard);
  if (!r.rowCount) throw new TaskerError('Шаблон не найден', 'bad_request', 404);
  return one(id);
}

/** Новый порядок вариантов показателя: ids сверху вниз → sort_order 10, 20, … */
export async function reorderTemplates(session: SessionUser, metricId: string, ids: number[]): Promise<void> {
  if (!metricId || !ids.length) throw new TaskerError('Пустой порядок');
  await systemDb().query(
    `UPDATE tasker_templates t SET sort_order = x.ord * 10, updated_by = $3, updated_at = now()
       FROM unnest($2::int[]) WITH ORDINALITY AS x(id, ord)
      WHERE t.id = x.id AND t.metric_id = $1`,
    [metricId, ids, session.login],
  );
}

/** Удаление — только для архивных (чтобы не потерять случайно рабочий вариант); задачи хранят свою копию
 *  текста, ссылка template_id обнулится (ON DELETE SET NULL). */
export async function deleteTemplate(id: number): Promise<void> {
  const r = await systemDb().query(`DELETE FROM tasker_templates WHERE id = $1 AND NOT active`, [id]);
  if (!r.rowCount) throw new TaskerError('Удалить можно только вариант из архива');
}

export async function saveTemplateImage(session: SessionUser, file: File): Promise<{ id: string; url: string }> {
  if (!(TEMPLATE_IMAGE_MIME as readonly string[]).includes(file.type)) throw new TaskerError('Картинка: только PNG, JPEG, WebP или GIF');
  if (file.size > TEMPLATE_IMAGE_MAX_BYTES) throw new TaskerError(`Картинка больше ${TEMPLATE_IMAGE_MAX_BYTES / 1024 / 1024} МБ`);
  const buf = Buffer.from(await file.arrayBuffer());
  const r = await systemDb().query<{ id: string }>(
    `INSERT INTO tasker_template_images (filename, mime_type, byte_size, data, uploaded_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [(file.name || 'image').slice(0, 200), file.type, buf.length, buf, session.login],
  );
  const id = r.rows[0].id;
  return { id, url: `${appBaseUrl()}/api/tasker/templates/images/${id}` };
}

export async function loadTemplateImage(id: string): Promise<{ data: Buffer; mime: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await systemDb().query<{ data: Buffer; mime_type: string }>(
    `SELECT data, mime_type FROM tasker_template_images WHERE id = $1`, [id],
  );
  return r.rows[0] ? { data: r.rows[0].data, mime: r.rows[0].mime_type } : null;
}
