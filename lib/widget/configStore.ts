import { systemDb } from '@/lib/db/clients';
import { normalizeMetricIds, DEFAULT_WIDGET_COLORS, type WidgetConfig, type WidgetFamily, type WidgetColors } from './config';

interface Row {
  family: string; param: string; metrics: string[]; viz_kind: string;
  scope_kind: string; scope_id: string | null; period_preset: string;
  colors: unknown;
}

// Строки могли быть сохранены до переработки 17.07 (старые id метрик, colors без
// theme/accent) — нормализуем при чтении, чтобы срез/рендер всегда получали новый формат.
function rowColors(raw: unknown): WidgetColors {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    theme: r.theme === 'light' ? 'light' : 'dark',
    accent: typeof r.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.accent) ? r.accent.toLowerCase() : DEFAULT_WIDGET_COLORS.accent,
  };
}

function rowToConfig(r: Row): WidgetConfig {
  return {
    family: r.family as WidgetFamily,
    param: r.param,
    metrics: normalizeMetricIds(r.metrics),
    viz_kind: r.viz_kind as WidgetConfig['viz_kind'],
    scope_kind: r.scope_kind as WidgetConfig['scope_kind'],
    scope_id: r.scope_id,
    period_preset: r.period_preset as WidgetConfig['period_preset'],
    colors: rowColors(r.colors),
  };
}

export async function loadWidgetConfig(userId: string, family: string, param: string): Promise<WidgetConfig | null> {
  const res = await systemDb().query<Row>(
    `SELECT family, param, metrics, viz_kind, scope_kind, scope_id, period_preset, colors
       FROM widget_configs WHERE user_id = $1 AND family = $2 AND param = $3`,
    [userId, family, param],
  );
  return res.rows[0] ? rowToConfig(res.rows[0]) : null;
}

export async function loadAllWidgetConfigs(userId: string): Promise<WidgetConfig[]> {
  const res = await systemDb().query<Row>(
    `SELECT family, param, metrics, viz_kind, scope_kind, scope_id, period_preset, colors
       FROM widget_configs WHERE user_id = $1 ORDER BY family, param`,
    [userId],
  );
  return res.rows.map(rowToConfig);
}

export async function saveWidgetConfig(userId: string, c: WidgetConfig): Promise<void> {
  await systemDb().query(
    `INSERT INTO widget_configs
       (user_id, family, param, metrics, viz_kind, scope_kind, scope_id, period_preset, colors, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (user_id, family, param) DO UPDATE SET
       metrics = EXCLUDED.metrics, viz_kind = EXCLUDED.viz_kind,
       scope_kind = EXCLUDED.scope_kind, scope_id = EXCLUDED.scope_id,
       period_preset = EXCLUDED.period_preset, colors = EXCLUDED.colors,
       updated_at = now()`,
    [userId, c.family, c.param, c.metrics, c.viz_kind, c.scope_kind, c.scope_id, c.period_preset, JSON.stringify(c.colors)],
  );
}
