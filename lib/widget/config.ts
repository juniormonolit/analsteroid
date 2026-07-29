import { WIDGET_METRIC_IDS, WIDGET_METRICS, LEGACY_METRIC_MAP, type WidgetMetricId } from './metrics';
import { WIDGET_PERIOD_PRESETS, type WidgetPeriodPreset } from './periods';

export type WidgetFamily = 'small' | 'medium' | 'large';
export type WidgetVizKind = 'ring' | 'line' | 'bar';
export type WidgetScopeKind = 'russia' | 'branch' | 'department';
export type WidgetTheme = 'dark' | 'light';

export interface WidgetColors {
  theme: WidgetTheme;
  /** Акцентный hex прогресс-дуги (палитра Google Sheets в конструкторе). */
  accent: string;
}

export interface WidgetConfig {
  family: WidgetFamily;
  param: string;
  metrics: WidgetMetricId[];
  viz_kind: WidgetVizKind;
  scope_kind: WidgetScopeKind;
  scope_id: string | null; // department_id / 'СПБ'|'МСК'|'КРД' / null для russia
  period_preset: WidgetPeriodPreset;
  colors: WidgetColors;
}

export const WIDGET_FAMILIES: WidgetFamily[] = ['small', 'medium', 'large'];
export const WIDGET_VIZ_KINDS: WidgetVizKind[] = ['ring', 'line', 'bar'];
export const WIDGET_SCOPE_KINDS: WidgetScopeKind[] = ['russia', 'branch', 'department'];

// Дефолт — тёмный «glassmorphism» с белой дугой (референс владельца 07.07/17.07).
export const DEFAULT_WIDGET_COLORS: WidgetColors = { theme: 'dark', accent: '#ffffff' };

export function defaultWidgetConfig(family: WidgetFamily): WidgetConfig {
  return {
    family,
    param: '',
    metrics: ['sales_completion', 'shipments_completion'],
    viz_kind: 'ring',
    scope_kind: 'russia',
    scope_id: null,
    period_preset: 'this_month',
    colors: { ...DEFAULT_WIDGET_COLORS },
  };
}

const metricById = new Map(WIDGET_METRICS.map(m => [m.id, m]));

/** Старые id (до переработки 17.07) → новые; неизвестные отбрасываются. */
export function normalizeMetricIds(raw: unknown[]): WidgetMetricId[] {
  const out: WidgetMetricId[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const mapped = (LEGACY_METRIC_MAP[v] ?? v) as WidgetMetricId;
    if ((WIDGET_METRIC_IDS as string[]).includes(mapped) && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function sanitizeColors(raw: unknown): WidgetColors {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const theme: WidgetTheme = r.theme === 'light' ? 'light' : 'dark';
  const accent = typeof r.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.accent)
    ? r.accent.toLowerCase()
    : DEFAULT_WIDGET_COLORS.accent;
  return { theme, accent };
}

/** Валидирует и нормализует конфиг из тела запроса (400 при ошибке). */
export function validateWidgetConfig(raw: unknown): { ok: true; config: WidgetConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Пустое тело конфига' };
  const r = raw as Record<string, unknown>;

  const family = r.family;
  if (!WIDGET_FAMILIES.includes(family as WidgetFamily)) return { ok: false, error: 'Некорректный family' };

  const param = typeof r.param === 'string' ? r.param.slice(0, 64) : '';

  const metrics = normalizeMetricIds(Array.isArray(r.metrics) ? r.metrics : []);
  if (metrics.length === 0) return { ok: false, error: 'Выберите хотя бы один показатель' };

  const viz_kind = r.viz_kind;
  if (!WIDGET_VIZ_KINDS.includes(viz_kind as WidgetVizKind)) return { ok: false, error: 'Некорректный вид визуализации' };

  const scope_kind = r.scope_kind;
  if (!WIDGET_SCOPE_KINDS.includes(scope_kind as WidgetScopeKind)) return { ok: false, error: 'Некорректный разрез' };

  let scope_id: string | null = null;
  if (scope_kind !== 'russia') {
    if (typeof r.scope_id !== 'string' || !r.scope_id) return { ok: false, error: 'Не выбран отдел/филиал' };
    scope_id = r.scope_id;
  }

  const period_preset = r.period_preset;
  if (!WIDGET_PERIOD_PRESETS.includes(period_preset as WidgetPeriodPreset)) return { ok: false, error: 'Некорректный период' };

  // Абсолютные ₽-метрики — только в годовом разрезе (решение владельца 17.07).
  if (period_preset !== 'this_year' && metrics.some(m => metricById.get(m)?.yearOnly)) {
    return { ok: false, error: 'Абсолютные суммы доступны только для периода «Этот год»' };
  }

  return {
    ok: true,
    config: {
      family: family as WidgetFamily,
      param,
      metrics,
      viz_kind: viz_kind as WidgetVizKind,
      scope_kind: scope_kind as WidgetScopeKind,
      scope_id,
      period_preset: period_preset as WidgetPeriodPreset,
      colors: sanitizeColors(r.colors),
    },
  };
}
