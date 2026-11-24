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
import { TaskerError, loadMetricDefs, publicMetric, type TaskerMetricDef } from './config';

const LABEL_MAX = 80;

const formatOf = (m: Pick<Metric, 'dataType'>): TaskerMetric['format'] =>
  m.dataType === 'percent' ? 'percent' : m.dataType === 'money' ? 'money' : 'number';
/**
 * Группа темы-показателя — автоматически по категории метрики в каталоге (правка владельца 23.11: поле «Группа»
 * из формы убрано). Маппинг категорий каталога (metrics.category):
 *   Конверсии, Отказы                          → conversion («Конверсии»)
 *   Продажи, Средний чек, Отгрузки, Планы      → check («Чеки»)
 *   Звонки, Активность, Сделки, Брони, Клиенты → activity («Активность»)
 *   Повторные / Повторка                       → repeat («Повторка»)
 * Категории нет или она новая — по формату: % → conversion, ₽ → check, число → activity.
 * Тема по товарной группе — всегда product. Набор групп — CHECK из миграции 282, без новой миграции.
 */
const CATEGORY_GROUP: Record<string, TaskerMetricGroup> = {
  'конверсии': 'conversion', 'отказы': 'conversion',
  'продажи': 'check', 'средний чек': 'check', 'отгрузки': 'check', 'планы': 'check',
  'звонки': 'activity', 'активность': 'activity', 'сделки': 'activity', 'брони': 'activity', 'клиенты': 'activity',
  'повторные': 'repeat', 'повторка': 'repeat',
};
export function groupOfMetric(m: Pick<Metric, 'category'>, format: TaskerMetric['format']): TaskerMetricGroup {
  const byCat = m.category ? CATEGORY_GROUP[m.category.trim().toLowerCase()] : undefined;
  return byCat ?? (format === 'percent' ? 'conversion' : format === 'money' ? 'check' : 'activity');
}
/** Счётчик/сумма (не доля и не среднее): «своё среднее за 6 мес.» приводится к длине периода. */
const additiveOf = (m: Pick<Metric, 'dataType' | 'aggregationFn'>) => m.dataType !== 'percent' && m.aggregationFn === 'sum';

/**
 * «Больше/меньше — лучше», которое можно вывести надёжно — дефолт для поля формы (само поле остаётся):
 *  - уже заведённые темы (tasker_metrics, включая архив) — решение руководителей;
 *  - узлы диагностики (diag_nodes.higher_is_better по metric_id), только если все узлы метрики согласны.
 * В каталоге метрик своего признака направления нет — остальным дефолт «больше — лучше» в форме.
 */
async function knownDirections(): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const diag = await systemDb().query<{ metric_id: string; hib: boolean }>(
    `SELECT metric_id, bool_and(higher_is_better) AS hib FROM diag_nodes
      WHERE metric_id IS NOT NULL GROUP BY metric_id HAVING bool_and(higher_is_better) = bool_or(higher_is_better)`,
  ).then(r => r.rows).catch(() => []);
  for (const d of diag) out.set(d.metric_id, d.hib);
  const own = await systemDb().query<{ id: string; higher_is_better: boolean }>(
    `SELECT id, higher_is_better FROM tasker_metrics`,
  ).then(r => r.rows).catch(() => []);
  for (const t of own) out.set(t.id, t.higher_is_better);
  return out;
}

/** Каталог для конструктора: метрики отчётов (видимые, не тестовые) и активные товарные группы (kc). */
export async function topicCatalog(): Promise<TaskerTopicCatalogResponse> {
  const [metrics, pg, direction] = await Promise.all([
    loadMetrics(),
    analyticsDb().query<{ id: number; name: string }>(`SELECT id, name FROM sa.product_groups WHERE is_active = true ORDER BY name`)
      .then(r => r.rows).catch(() => [] as { id: number; name: string }[]),
    knownDirections(),
  ]);
  return {
    metrics: metrics
      .filter(m => m.isActive && !m.isHiddenInUi && !m.isTest)
      .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '', 'ru') || a.sortOrder - b.sortOrder)
      .map(m => ({
        id: m.id, name: m.nameRu, shortName: m.nameShortRu, category: m.category, format: formatOf(m),
        higherIsBetter: direction.get(m.id) ?? null,
      })),
    productGroups: pg.map(g => ({ id: String(g.id), name: g.name })),
  };
}

function cleanCommon(req: TaskerTopicSaveRequest) {
  const label = typeof req.label === 'string' ? req.label.trim().slice(0, LABEL_MAX) : undefined;
  // Группа от клиента не принимается — считается по каталогу (groupOfMetric) / 'product' для товарной группы.
  // Формат от клиента не принимается: у показателя — из каталога (dataType), у товарной группы — по замеру.
  const sortOrder = req.sortOrder !== undefined && Number.isFinite(Number(req.sortOrder)) ? Math.round(Number(req.sortOrder)) : undefined;
  return {
    label, sortOrder,
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
      [id, label, 'product', c.higherIsBetter ?? true, format, label.slice(0, 40), measure === 'amount',
        c.sortOrder ?? null, pgId, measure, session.login],
    ).then(r => { if (!r.rowCount) throw new TaskerError('Такая тема уже есть'); });
    return topicById(id);
  }

  const metricId = String(req.metricId ?? '').trim();
  const m = (await loadMetrics()).find(x => x.id === metricId && x.isActive && !x.isTest);
  if (!m) throw new TaskerError('Выберите показатель из каталога отчётов');
  const format = formatOf(m);
  const label = c.label || m.nameShortRu || m.nameRu;
  await db.query(
    `INSERT INTO tasker_metrics (id, label, grp, higher_is_better, format, tag, denominator_ids, additive, sort_order,
                                 kind, created_by, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, COALESCE($8, ${nextSort}), 'metric', $9, $9, now())
     ON CONFLICT (id) DO UPDATE SET active = true, archived_at = NULL, label = EXCLUDED.label, grp = EXCLUDED.grp,
       higher_is_better = EXCLUDED.higher_is_better, format = EXCLUDED.format, tag = EXCLUDED.tag,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE NOT tasker_metrics.active`,
    [m.id, label, groupOfMetric(m, format), c.higherIsBetter ?? (await knownDirections()).get(m.id) ?? true, format, label.slice(0, 40), additiveOf(m),
      c.sortOrder ?? null, session.login],
  ).then(r => { if (!r.rowCount) throw new TaskerError('Такая тема уже есть'); });
  return topicById(m.id);
}

export async function updateTopic(session: SessionUser, id: string, req: TaskerTopicSaveRequest): Promise<TaskerMetric> {
  const c = cleanCommon(req);
  if (c.label === '') throw new TaskerError('Нужно название темы');
  const cur = (await loadMetricDefs()).find(x => x.id === id);
  if (!cur) throw new TaskerError('Тема не найдена', 'bad_request', 404);
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
    [id, c.label ?? null, null /* группа — только автоматически при создании */, c.higherIsBetter ?? null, null /* формат — только из каталога/замера при создании */, c.sortOrder ?? null, c.active ?? null, session.login],
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

// ── Товарная группа «на лету» (форма обучения / форма задачи, 24.11) ───────────
// Тренер (trainings.manage) и РОП (assign) темы не заводят, но могут выбрать товарную группу прямо в форме.
// Клиент шлёт детерминированный id темы pg_<id>_amount (замер по умолчанию — сумма продаж группы, как дефолт
// конструктора); сервер находит тему или создаёт её при сохранении. Архивная тема по такому выбору
// возвращается из архива: выбор группы в форме — явное решение.

export const PG_TOPIC_RE = /^pg_(\d+)_(amount|share)$/;

async function productGroupName(pgId: string): Promise<string> {
  const g = await analyticsDb().query<{ name: string }>(`SELECT name FROM sa.product_groups WHERE id = $1`, [Number(pgId)]);
  if (!g.rows[0]) throw new TaskerError('Товарная группа не найдена');
  return g.rows[0].name;
}

/** Создать (или вернуть из архива) тему товарной группы по её id темы; возвращает id. */
async function ensurePgTopic(login: string, id: string): Promise<string> {
  const m = PG_TOPIC_RE.exec(id);
  if (!m) throw new TaskerError('Тема не из списка Задачника');
  const [, pgId, measure] = m;
  const name = await productGroupName(pgId);
  const label = measure === 'share' ? `${name}: доля в продажах` : name;
  await systemDb().query(
    `INSERT INTO tasker_metrics (id, label, grp, higher_is_better, format, tag, denominator_ids, additive, sort_order,
                                 kind, product_group_id, pg_measure, created_by, updated_by, updated_at)
     VALUES ($1, $2, 'product', true, $3, $4, '{}', $5, ${nextSort}, 'product_group', $6, $7, $8, $8, now())
     ON CONFLICT (id) DO UPDATE SET active = true, archived_at = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE NOT tasker_metrics.active`,
    [id, label, measure === 'share' ? 'percent' : 'money', label.slice(0, 40), measure === 'amount', pgId, measure, login],
  );
  return id;
}

/**
 * Тема для создания задачи / снимка. Обычная — как metricDef (только активные). Неизвестный id вида pg_<id>_<замер>:
 *  - mode 'virtual' (снимок в форме, задача ещё не поставлена) — описание темы в памяти, без записи в БД;
 *  - mode 'ensure' (сохранение задачи) — тема создаётся / возвращается из архива.
 */
export async function resolveTopic(id: string, mode: 'virtual' | { ensureBy: string }): Promise<TaskerMetricDef> {
  const defs = await loadMetricDefs();
  const found = defs.find(x => x.id === id);
  const pg = PG_TOPIC_RE.exec(id);
  if (found && (found.active || !pg)) {
    if (!found.active) throw new TaskerError('Тема в архиве — выберите другую');
    return found;
  }
  if (!pg) throw new TaskerError('Тема не из списка Задачника');
  if (mode !== 'virtual') {
    await ensurePgTopic(mode.ensureBy, id);
    const d = (await loadMetricDefs()).find(x => x.id === id);
    if (!d) throw new TaskerError('Не удалось завести тему товарной группы');
    return d;
  }
  const [, pgId, measure] = pg;
  const name = await productGroupName(pgId);
  const label = measure === 'share' ? `${name}: доля в продажах` : name;
  return {
    id, label, group: 'product', higherIsBetter: true, format: measure === 'share' ? 'percent' : 'money', tag: label.slice(0, 40),
    sortOrder: 9999, denominatorIds: [], additive: measure === 'amount', kind: 'product_group', productGroupId: pgId,
    pgMeasure: measure as TaskerPgMeasure, active: true,
  };
}

/** Список id тем из формы обучения: pg_<id>_<замер> без темы — создаются; прочие — как есть. */
export async function ensureTopicIds(login: string, ids: string[]): Promise<void> {
  const known = new Set((await loadMetricDefs()).filter(d => d.active).map(d => d.id));
  for (const id of ids) if (!known.has(id) && PG_TOPIC_RE.test(id)) await ensurePgTopic(login, id);
}

/** Справочник товарных групп (шкала kc) — для форм обучения и задачи. */
export async function productGroupOptions(): Promise<{ id: string; name: string }[]> {
  const r = await analyticsDb().query<{ id: number; name: string }>(`SELECT id, name FROM sa.product_groups WHERE is_active = true ORDER BY name`);
  return r.rows.map(g => ({ id: String(g.id), name: g.name }));
}
