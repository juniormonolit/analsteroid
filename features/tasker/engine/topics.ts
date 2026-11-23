// Задачник: темы задач в конструкторе (задача владельца 23.11, миграция 282). Тема — строка tasker_metrics:
//  - «Показатель» — любая метрика каталога отчётов (lib/metrics/catalog.ts); id темы = id метрики;
//  - «Материалы по товарной группе» — группа из sa.product_groups (шкала kc, тот же справочник, что отчёт
//    «По товарным группам»); id темы = pg_<id>_<amount|share>; замер — features/tasker/engine/snapshot.ts.
// Удаления нет — архив (active = false): старые задачи с темой считаются и подписываются дальше.
// Право — action.tasker.templates (canManageTemplates), как у шаблонов.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { loadMetrics } from '@/lib/metrics/catalog';
import type { Metric } from '@/lib/metrics/types';
import type {
  TaskerMetric, TaskerMetricGroup, TaskerPgMeasure, TaskerTopicCatalogResponse, TaskerTopicSaveRequest,
} from '../types';
import { TaskerError, loadMetricDefs, publicMetric } from './config';

const GROUPS: TaskerMetricGroup[] = ['conversion', 'check', 'activity', 'repeat', 'product'];
const FORMATS: TaskerMetric['format'][] = ['percent', 'money', 'number'];
const LABEL_MAX = 80;

const formatOf = (m: Pick<Metric, 'dataType'>): TaskerMetric['format'] =>
  m.dataType === 'percent' ? 'percent' : m.dataType === 'money' ? 'money' : 'number';
const groupOf = (f: TaskerMetric['format']): TaskerMetricGroup => (f === 'percent' ? 'conversion' : f === 'money' ? 'check' : 'activity');
/** Счётчик/сумма (не доля и не среднее): «своё среднее за 6 мес.» приводится к длине периода. */
const additiveOf = (m: Pick<Metric, 'dataType' | 'aggregationFn'>) => m.dataType !== 'percent' && m.aggregationFn === 'sum';

/** Каталог для конструктора: метрики отчётов (видимые, не тестовые) и активные товарные группы (kc). */
export async function topicCatalog(): Promise<TaskerTopicCatalogResponse> {
  const [metrics, pg] = await Promise.all([
    loadMetrics(),
    analyticsDb().query<{ id: number; name: string }>(`SELECT id, name FROM sa.product_groups WHERE is_active = true ORDER BY name`)
      .then(r => r.rows).catch(() => [] as { id: number; name: string }[]),
  ]);
  return {
    metrics: metrics
      .filter(m => m.isActive && !m.isHiddenInUi && !m.isTest)
      .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '', 'ru') || a.sortOrder - b.sortOrder)
      .map(m => ({ id: m.id, name: m.nameRu, shortName: m.nameShortRu, category: m.category, format: formatOf(m) })),
    productGroups: pg.map(g => ({ id: String(g.id), name: g.name })),
  };
}

function cleanCommon(req: TaskerTopicSaveRequest) {
  const label = typeof req.label === 'string' ? req.label.trim().slice(0, LABEL_MAX) : undefined;
  const group = req.group !== undefined ? (GROUPS.includes(req.group) ? req.group : null) : undefined;
  if (group === null) throw new TaskerError('Неизвестная группа темы');
  const format = req.format !== undefined ? (FORMATS.includes(req.format) ? req.format : null) : undefined;
  if (format === null) throw new TaskerError('Неизвестный формат');
  const sortOrder = req.sortOrder !== undefined && Number.isFinite(Number(req.sortOrder)) ? Math.round(Number(req.sortOrder)) : undefined;
  return {
    label, group, format, sortOrder,
    higherIsBetter: typeof req.higherIsBetter === 'boolean' ? req.higherIsBetter : undefined,
    active: typeof req.active === 'boolean' ? req.active : undefined,
  };
}

async function topicById(id: string): Promise<TaskerMetric> {
  const t = (await loadMetricDefs()).find(x => x.id === id);
  if (!t) throw new TaskerError('Тема не найдена', 'bad_request', 404);
  return publicMetric(t);
}

const nextSort = `(SELECT COALESCE(MAX(sort_order), 0) + 10 FROM tasker_metrics)`;

export async function createTopic(session: SessionUser, req: TaskerTopicSaveRequest): Promise<TaskerMetric> {
  const c = cleanCommon(req);
  const db = systemDb();
  if (req.kind === 'product_group') {
    const pgId = String(req.productGroupId ?? '').trim();
    const measure: TaskerPgMeasure = req.pgMeasure === 'share' ? 'share' : 'amount';
    if (!/^\d+$/.test(pgId)) throw new TaskerError('Выберите товарную группу');
    const g = await analyticsDb().query<{ name: string }>(`SELECT name FROM sa.product_groups WHERE id = $1`, [Number(pgId)]);
    if (!g.rows[0]) throw new TaskerError('Товарная группа не найдена');
    const id = `pg_${pgId}_${measure}`;
    const label = c.label || (measure === 'share' ? `${g.rows[0].name}: доля в продажах` : g.rows[0].name);
    const format = measure === 'share' ? 'percent' : 'money';
    await db.query(
      `INSERT INTO tasker_metrics (id, label, grp, higher_is_better, format, tag, denominator_ids, additive, sort_order,
                                   kind, product_group_id, pg_measure, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, COALESCE($8, ${nextSort}), 'product_group', $9, $10, $11, $11, now())
       ON CONFLICT (id) DO UPDATE SET active = true, archived_at = NULL, label = EXCLUDED.label, grp = EXCLUDED.grp,
         higher_is_better = EXCLUDED.higher_is_better, tag = EXCLUDED.tag, updated_by = EXCLUDED.updated_by, updated_at = now()
       WHERE NOT tasker_metrics.active`,
      [id, label, c.group ?? 'product', c.higherIsBetter ?? true, format, label.slice(0, 40), measure === 'amount',
        c.sortOrder ?? null, pgId, measure, session.login],
    ).then(r => { if (!r.rowCount) throw new TaskerError('Такая тема уже есть'); });
    return topicById(id);
  }

  const metricId = String(req.metricId ?? '').trim();
  const m = (await loadMetrics()).find(x => x.id === metricId && x.isActive && !x.isTest);
  if (!m) throw new TaskerError('Выберите показатель из каталога отчётов');
  const format = c.format ?? formatOf(m);
  const label = c.label || m.nameShortRu || m.nameRu;
  await db.query(
    `INSERT INTO tasker_metrics (id, label, grp, higher_is_better, format, tag, denominator_ids, additive, sort_order,
                                 kind, created_by, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, COALESCE($8, ${nextSort}), 'metric', $9, $9, now())
     ON CONFLICT (id) DO UPDATE SET active = true, archived_at = NULL, label = EXCLUDED.label, grp = EXCLUDED.grp,
       higher_is_better = EXCLUDED.higher_is_better, format = EXCLUDED.format, tag = EXCLUDED.tag,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE NOT tasker_metrics.active`,
    [m.id, label, c.group ?? groupOf(format), c.higherIsBetter ?? true, format, label.slice(0, 40), additiveOf(m),
      c.sortOrder ?? null, session.login],
  ).then(r => { if (!r.rowCount) throw new TaskerError('Такая тема уже есть'); });
  return topicById(m.id);
}

export async function updateTopic(session: SessionUser, id: string, req: TaskerTopicSaveRequest): Promise<TaskerMetric> {
  const c = cleanCommon(req);
  if (c.label === '') throw new TaskerError('Нужно название темы');
  const cur = (await loadMetricDefs()).find(x => x.id === id);
  if (!cur) throw new TaskerError('Тема не найдена', 'bad_request', 404);
  // У товарной группы формат задан способом замера (сумма — ₽, доля — %).
  const format = cur.kind === 'product_group' ? undefined : c.format;
  await systemDb().query(
    `UPDATE tasker_metrics SET
        label            = COALESCE($2, label),
        tag              = COALESCE(left($2, 40), tag),
        grp              = COALESCE($3, grp),
        higher_is_better = COALESCE($4, higher_is_better),
        format           = COALESCE($5, format),
        sort_order       = COALESCE($6, sort_order),
        active           = COALESCE($7, active),
        archived_at      = CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN NULL ELSE COALESCE(archived_at, now()) END,
        updated_by       = $8,
        updated_at       = now()
      WHERE id = $1`,
    [id, c.label ?? null, c.group ?? null, c.higherIsBetter ?? null, format ?? null, c.sortOrder ?? null, c.active ?? null, session.login],
  );
  return topicById(id);
}

/** Новый порядок тем: ids сверху вниз → sort_order 10, 20, … (порядок в форме задачи). */
export async function reorderTopics(session: SessionUser, ids: string[]): Promise<void> {
  if (!ids.length) throw new TaskerError('Пустой порядок');
  await systemDb().query(
    `UPDATE tasker_metrics t SET sort_order = x.ord * 10, updated_by = $2, updated_at = now()
       FROM unnest($1::text[]) WITH ORDINALITY AS x(id, ord) WHERE t.id = x.id`,
    [ids, session.login],
  );
}
