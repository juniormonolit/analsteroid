// Задачник — настройки и справочники (tasker_settings / tasker_metrics / tasker_templates, миграция 274).
import { systemDb } from '@/lib/db/clients';
import { bitrixPortalOrigin } from '@/lib/bitrix/appAuth';
import type { TaskerMetric, TaskerMetricGroup, TaskerPgMeasure, TaskerTemplate, TaskerTopicKind } from '../types';

export const MAX_OPEN_TASKS = 3;
/** Порог «мало данных»: знаменатель метрики < 5 (ТЗ, вопрос 8). */
export const MIN_DENOMINATOR = 5;
export const SESSION_BASE_MIN = 30;
export const SESSION_PER_EXTRA_MIN = 15;
export const DEFAULT_DIRECTOR_BITRIX_ID = '1860'; // Осипов Сергей (lib/weather/weeklyWeather.ts)
/** Тренер для задач «Теория» (Будковский), если tasker_settings.trainer не задан. */
export const DEFAULT_TRAINER_BITRIX_ID = '2054';
/** Окно замера по умолчанию: контрольная дата = срок + 7 дней (правка 23.11: «смотрим неделя через неделю»). */
export const DEFAULT_CONTROL_DAYS = 7;

export class TaskerError extends Error {
  constructor(message: string, readonly code: 'not_configured' | 'forbidden' | 'bad_request' | 'limit' | 'bitrix' = 'bad_request', readonly status = 400) {
    super(message);
  }
}

export const NOT_CONFIGURED_MESSAGE = 'Не настроен проект Задачника в Битриксе: владелец ещё не задал ID группы (tasker_settings.group_id). Остальное работает, создание задач — после настройки.';

export function errorResponse(e: unknown): Response {
  if (e instanceof TaskerError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  // Таблиц ещё нет (миграция 274 не накачена) — понятный ответ вместо 500.
  if ((e as { code?: string })?.code === '42P01' && /tasker_/.test((e as Error).message ?? '')) {
    return Response.json({ error: 'Задачник ещё не развёрнут: не применена миграция 274_tasker_core.sql' }, { status: 503 });
  }
  console.error('[tasker]', e);
  return Response.json({ error: e instanceof Error ? e.message : 'Ошибка Задачника' }, { status: 500 });
}

export const portalBaseUrl = () => (bitrixPortalOrigin() || 'https://td.monolit-crm.ru');
export const appBaseUrl = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/+$/, '');

export function bitrixTaskUrl(taskId: number, groupId: number | null): string {
  return groupId
    ? `${portalBaseUrl()}/workgroups/group/${groupId}/tasks/task/view/${taskId}/`
    : `${portalBaseUrl()}/company/personal/user/0/tasks/task/view/${taskId}/`;
}

// ── Настройки ───────────────────────────────────────────────────────────────

export interface TaskerSettings {
  groupId: number | null;
  /** Bitrix ID директора по филиалу; 'default' — для всех остальных. */
  directors: Record<string, string>;
  /** Bitrix ID тренера — исполнитель задач «Теория». */
  trainerId: string;
}

export async function loadSettings(): Promise<TaskerSettings> {
  const r = await systemDb().query<{ key: string; value: unknown }>(`SELECT key, value FROM tasker_settings`);
  const map = new Map(r.rows.map(x => [x.key, x.value]));
  const g = Number(map.get('group_id'));
  const dirs = (map.get('directors') ?? {}) as Record<string, unknown>;
  const directors: Record<string, string> = { default: DEFAULT_DIRECTOR_BITRIX_ID };
  for (const [k, v] of Object.entries(dirs)) if (v != null && String(v).trim()) directors[k] = String(v).trim();
  const tr = String(map.get('trainer') ?? '').trim();
  return { groupId: Number.isInteger(g) && g > 0 ? g : null, directors, trainerId: /^\d+$/.test(tr) ? tr : DEFAULT_TRAINER_BITRIX_ID };
}

export function directorFor(settings: TaskerSettings, branch: string | null | undefined): string {
  return (branch && settings.directors[branch]) || settings.directors.default || DEFAULT_DIRECTOR_BITRIX_ID;
}

// ── Метрики и шаблоны ───────────────────────────────────────────────────────

export interface TaskerMetricDef extends TaskerMetric {
  denominatorIds: string[];
  additive: boolean;
  kind: TaskerTopicKind;
  productGroupId: string | null;
  pgMeasure: TaskerPgMeasure | null;
  active: boolean;
}

interface MetricRow {
  id: string; label: string; grp: TaskerMetricGroup; higher_is_better: boolean;
  format: TaskerMetric['format']; tag: string; denominator_ids: string[]; additive: boolean; sort_order: number;
  active: boolean; kind?: TaskerTopicKind; product_group_id?: string | null; pg_measure?: TaskerPgMeasure | null;
  practice_plan?: string | null;
}

/**
 * Темы Задачника (tasker_metrics, миграции 274 + 282) — ВСЕ, вместе с архивом (active = false): по ним считаются и
 * подписываются старые задачи. Списки выбора (форма, обучения) фильтруют active сами; metricDef — только активные.
 * До наката 282 колонок типа нет — читаем по-старому, всё = показатели.
 */
export async function loadMetricDefs(): Promise<TaskerMetricDef[]> {
  const base = `id, label, grp, higher_is_better, format, tag, denominator_ids, additive, sort_order, active`;
  const order = `ORDER BY active DESC, sort_order, label, id`;
  // practice_plan — с миграции 302, kind/product_group_id/pg_measure — с 282: без колонок читаем по-старому.
  const r = await systemDb().query<MetricRow>(
    `SELECT ${base}, kind, product_group_id, pg_measure, practice_plan FROM tasker_metrics ${order}`,
  ).catch(e => {
    if ((e as { code?: string })?.code !== '42703') throw e;
    return systemDb().query<MetricRow>(`SELECT ${base}, kind, product_group_id, pg_measure FROM tasker_metrics ${order}`);
  }).catch(e => {
    if ((e as { code?: string })?.code !== '42703') throw e;
    return systemDb().query<MetricRow>(`SELECT ${base} FROM tasker_metrics ${order}`);
  });
  return r.rows.map(m => ({
    id: m.id, label: m.label, group: m.grp, higherIsBetter: m.higher_is_better, format: m.format,
    tag: m.tag, sortOrder: m.sort_order, denominatorIds: m.denominator_ids ?? [], additive: m.additive,
    kind: m.kind ?? 'metric', productGroupId: m.product_group_id ?? null, pgMeasure: m.pg_measure ?? null, active: m.active,
    practicePlan: m.practice_plan ?? null,
  }));
}

export async function metricDef(id: string): Promise<TaskerMetricDef> {
  const m = (await loadMetricDefs()).find(x => x.id === id);
  if (!m) throw new TaskerError('Тема не из списка Задачника');
  if (!m.active) throw new TaskerError('Тема в архиве — выберите другую');
  return m;
}

export function publicMetric(m: TaskerMetricDef): TaskerMetric {
  return {
    id: m.id, label: m.label, group: m.group, higherIsBetter: m.higherIsBetter, format: m.format, tag: m.tag, sortOrder: m.sortOrder,
    kind: m.kind, productGroupId: m.productGroupId, pgMeasure: m.pgMeasure, active: m.active, practicePlan: m.practicePlan ?? null,
  };
}

export async function loadTemplates(metricId?: string | null): Promise<TaskerTemplate[]> {
  const r = await systemDb().query<{ id: number; metric_id: string; title: string; body: string; sort_order: number }>(
    `SELECT id, metric_id, title, body, sort_order FROM tasker_templates
      WHERE active AND ($1::text IS NULL OR metric_id = $1) ORDER BY metric_id, sort_order, id`,
    [metricId ?? null],
  );
  return r.rows.map(t => ({ id: t.id, metricId: t.metric_id, title: t.title, body: t.body, sortOrder: t.sort_order }));
}

// ── Форматирование значений ─────────────────────────────────────────────────

export function fmtValue(v: number | null | undefined, format: TaskerMetric['format']): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (format === 'percent') return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  if (format === 'money') return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

// ── Даты (всё — по Москве) ──────────────────────────────────────────────────

export function mskToday(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(0, 10);
}

/** YYYY-MM-DD → ISO c +03:00; ISO оставляем как есть. */
export function toMskIso(v: string, defaultTime = '18:00:00'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T${defaultTime}+03:00`;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new TaskerError(`Некорректная дата: ${v}`);
  return d.toISOString();
}

export function isYmd(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((new Date(`${toYmd}T00:00:00Z`).getTime() - new Date(`${fromYmd}T00:00:00Z`).getTime()) / 86_400_000) + 1;
}

/** ISO → формат Битрикса с явным смещением МСК (как в канбане повторных). */
export function bxDate(iso: string): string {
  const msk = new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 19);
  return `${msk}+03:00`;
}
