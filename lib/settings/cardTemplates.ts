// Шаблоны карточек (owners-inbox бриф 10.07, «Шаблоны карточек» в Настройках): два
// шаблона — «Карточка менеджера» (features/manager-card/engine/managerCard.ts::buildManagerCard
// + teamCard.ts::buildTeamRoster, ФИФА-сетка «Мой отдел» — цифры менеджера в сетке ДОЛЖНЫ
// совпадать с его большой карточкой, поэтому оба читают ОДИН шаблон 'manager') и
// «Карточка отдела (РОП)» (teamCard.ts::buildDepartmentCard, шаблон 'department').
//
// Хранение — таблица card_templates (миграция 073, системная БД YC, см. миграцию для
// подробностей), паттерн singleton-по-ключу — тот же принцип, что scoring_weights
// (068)/plan_settings (016): TTL-кэш 60с, фолбэк на дефолт при отсутствии
// таблицы/строки (миграция ещё не накатана — код не должен падать).
//
// Гейт изменения — section.settings (НЕ superadmin-only, в отличие от /settings/scoring-weights
// и /settings/daily-plan-mode): явное решение владельца 10.07 — «админ должен видеть и менять».
// См. app/api/settings/card-templates/route.ts (permError, не superadminError).

import { systemDb } from '@/lib/db/clients';

export type TemplateKey = 'manager' | 'department';

// Каталог осей паутины. Первые 6 — исходные оси карточки v1/v2 (AXIS_DEFS в
// managerCard.ts, ключи колонок scoring_weights, миграция 068). Последние 2 —
// расширение каталога (бриф 10.07, п.2б): считаются ИЗ УЖЕ ЗАГРУЖЕННЫХ
// ReportRow.metrics (тот же periodPool/prevPool/allTimePool, что и остальные 6) —
// БЕЗ единого нового запроса к БД. Кандидаты вроде «доли недозвонов» отброшены —
// потребовали бы отдельный per-manager запрос к va.calls на весь пул (сейчас
// callsTizer считается только для ОДНОГО менеджера/отдела в карточке, не для всего
// пула ради перцентильной нормировки) — см. отчёт задачи.
export const AXIS_CATALOG_KEYS = [
  'cr_deal_to_reservation',
  'cr_reservation_to_sale',
  'sales_amount',
  'avg_check',
  'touch_speed',
  'refusal_rate',
  'cr_reservation_to_confirmed',
  'shipment_rate',
] as const;
export type CatalogAxisKey = (typeof AXIS_CATALOG_KEYS)[number];

export const TILE_CATALOG_KEYS = [
  'reservations',
  'confirmedReservations',
  'salesCount',
  'salesAmount',
  'shipments',
  'avgCheck',
] as const;
export type TileKey = (typeof TILE_CATALOG_KEYS)[number];

// Дефолт = ТЕКУЩЕЕ поведение (карточка v1/v2 до появления шаблонов): все 6 исходных
// осей, все 6 плиток. Максимум осей в шаблоне — 6 (бриф, п.2а), но каталог их 8.
export const DEFAULT_AXES: CatalogAxisKey[] = [
  'cr_deal_to_reservation', 'cr_reservation_to_sale', 'sales_amount',
  'avg_check', 'touch_speed', 'refusal_rate',
];
export const DEFAULT_TILES: TileKey[] = [...TILE_CATALOG_KEYS];
export const MAX_AXES = 6;

export interface CardTemplate {
  axes: CatalogAxisKey[]; // порядок = порядок осей в паутине
  tiles: TileKey[];
}

const DEFAULT_TEMPLATE: CardTemplate = { axes: DEFAULT_AXES, tiles: DEFAULT_TILES };

function isCatalogAxisKey(v: unknown): v is CatalogAxisKey {
  return typeof v === 'string' && (AXIS_CATALOG_KEYS as readonly string[]).includes(v);
}
function isTileKey(v: unknown): v is TileKey {
  return typeof v === 'string' && (TILE_CATALOG_KEYS as readonly string[]).includes(v);
}

/** Санитайзер для API PUT — фильтрует мусор, режет до MAX_AXES, убирает дубли. */
export function sanitizeAxes(raw: unknown): CatalogAxisKey[] {
  if (!Array.isArray(raw)) return DEFAULT_AXES;
  const clean = [...new Set(raw.filter(isCatalogAxisKey))].slice(0, MAX_AXES);
  return clean.length > 0 ? clean : DEFAULT_AXES;
}
export function sanitizeTiles(raw: unknown): TileKey[] {
  if (!Array.isArray(raw)) return DEFAULT_TILES;
  const clean = [...new Set(raw.filter(isTileKey))];
  return clean.length > 0 ? clean : DEFAULT_TILES;
}

const _cache = new Map<TemplateKey, { value: CardTemplate; at: number }>();
const TTL_MS = 60_000;

export async function getCardTemplate(key: TemplateKey): Promise<CardTemplate> {
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let value = DEFAULT_TEMPLATE;
  try {
    const res = await systemDb().query<{ axes: unknown; tiles: unknown }>(
      `SELECT axes, tiles FROM card_templates WHERE template_key = $1`,
      [key],
    );
    const row = res.rows[0];
    if (row) {
      value = { axes: sanitizeAxes(row.axes), tiles: sanitizeTiles(row.tiles) };
    }
  } catch {
    /* таблица/миграция ещё не накатана — дефолт = поведение как в v1/v2 до шаблонов */
  }
  _cache.set(key, { value, at: Date.now() });
  return value;
}

export function invalidateCardTemplatesCache(key?: TemplateKey): void {
  if (key) _cache.delete(key);
  else _cache.clear();
}
