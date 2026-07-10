// Шаблоны карточек (owners-inbox бриф 10.07, «Шаблоны карточек» в Настройках): два
// шаблона — «Карточка менеджера» (features/manager-card/engine/managerCard.ts::buildManagerCard
// + teamCard.ts::buildTeamRoster, ФИФА-сетка «Мой отдел» — цифры менеджера в сетке ДОЛЖНЫ
// совпадать с его большой карточкой, поэтому оба читают ОДИН шаблон 'manager') и
// «Карточка отдела (РОП)» (teamCard.ts::buildDepartmentCard, шаблон 'department').
//
// Хранение — таблица card_templates (миграция 073, системная БД YC), паттерн
// singleton-по-ключу — тот же принцип, что scoring_weights (068)/plan_settings (016):
// TTL-кэш 60с, фолбэк на дефолт при отсутствии таблицы/строки (код не должен падать).
//
// Гейт изменения — section.settings (НЕ superadmin-only, в отличие от /settings/scoring-weights
// и /settings/daily-plan-mode): явное решение владельца 10.07 — «админ должен видеть и менять».
// См. app/api/settings/card-templates/route.ts (permError, не superadminError).
//
// ── Задача 10.07 (пакет «шаблоны v2»), п.2: «оси паутины из ВСЕХ метрик каталога» ──
// БЫЛО: 8 зашитых ключей (AXIS_CATALOG_KEYS), invert хардкожен в managerCard.ts::
// AXIS_DEFS. СТАЛО: ось — {metricKey, invert} (миграция 075 переводит существующие
// строковые ключи в объекты), metricKey — ЛИБО «legacy:<8 исходных ключей>» (те же
// бесплатные бонус-формулы, что считались из ReportRow.metrics БЕЗ единого нового
// запроса — см. managerCard.ts::rawAxisValues), ЛИБО ЛЮБОЙ id из полного каталога
// метрик (lib/metrics/catalog.ts::loadMetrics(), ~195 видимых метрик — считается
// генерически через features/reports/engine/enrichManagerRows.ts, реюз byManagers/
// managerActivity/callsMetrics — см. отчёт задачи). invert теперь настройка ПО
// КАЖДОЙ оси в шаблоне (не хардкод в коде) — дефолт false, включён у legacy touch_speed/
// refusal_rate (сохраняет текущее поведение до наката 075).
//
// Префикс «legacy:» ОБЯЗАТЕЛЕН для исходных 8: 3 из них («cr_deal_to_reservation»,
// «cr_reservation_to_sale», «cr_reservation_to_confirmed») СОВПАДАЮТ по id с реальными
// метриками каталога («Конверсии», категория PRIMARY-scope из metrics.formula), но
// считаются ДРУГОЙ формулой (по ВСЕМ сделкам, не только первичным, см. managerCard.ts::
// rawAxisValues) — без префикса это была бы неустранимая коллизия имён с другим
// значением при выборе из каталога.
//
// ── Задача 10.07 (карточка v4), п.1: «плитки итогов из ВСЕХ метрик» ──────────────
// БЫЛО: 6 зашитых ключей (TILE_CATALOG_KEYS), чекбокс-список «показывать/нет»,
// ПОРЯДОК фиксирован (порядок массива TILE_CATALOG_KEYS). СТАЛО: плитка — ЛЮБАЯ
// метрика полного каталога, точно тот же паттерн хранения/UI, что и оси (п.2 выше) —
// «legacy:<6 исходных>» ИЛИ голый id каталога, порядок = порядок в массиве tiles
// (тот же приём переупорядочивания, что у осей). Инверсия («меньше — лучше») плиткам
// НЕ нужна (они не участвуют в скоринге/перцентиле — просто значение + Δ% к периоду
// сравнения, см. managerCard.ts::buildTileResults), поэтому tiles — ПРОСТОЙ массив
// строк (не {metricKey,invert}[], как у axes) и БЕЗ ограничения количества (в отличие
// от MAX_AXES=6 — «сетка растёт», см. отчёт задачи п.2 ТЗ). Миграция 083 переводит
// существующие 6 голых camelCase-ключей в «legacy:»-префиксные строки (тот же приём
// идемпотентного WHERE-guard, что и 075).

import { systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';

export type TemplateKey = 'manager' | 'department';

export const LEGACY_AXIS_KEYS = [
  'cr_deal_to_reservation',
  'cr_reservation_to_sale',
  'sales_amount',
  'avg_check',
  'touch_speed',
  'refusal_rate',
  'cr_reservation_to_confirmed',
  'shipment_rate',
] as const;
export type LegacyAxisKey = (typeof LEGACY_AXIS_KEYS)[number];

export const LEGACY_PREFIX = 'legacy:';
export function legacyStorageKey(k: LegacyAxisKey): string { return `${LEGACY_PREFIX}${k}`; }
export function isLegacyStorageKey(k: string): boolean {
  return k.startsWith(LEGACY_PREFIX) && (LEGACY_AXIS_KEYS as readonly string[]).includes(k.slice(LEGACY_PREFIX.length));
}
export function stripLegacyPrefix(k: string): LegacyAxisKey {
  return k.slice(LEGACY_PREFIX.length) as LegacyAxisKey;
}

// Подписи + дефолтный invert исходных 8 (совпадают с прежним поведением managerCard.ts
// AXIS_DEFS до задачи 10.07 — единственный источник подписи для UI списка/каталога).
export const LEGACY_AXIS_LABELS: Record<LegacyAxisKey, string> = {
  cr_deal_to_reservation: 'CR Сделка → Бронь (карточка, все сделки)',
  cr_reservation_to_sale: 'CR Бронь → Продажа (карточка, все сделки)',
  sales_amount: 'Сумма продаж',
  avg_check: 'Средний чек',
  touch_speed: 'Скорость касания',
  refusal_rate: 'Доля отказов',
  cr_reservation_to_confirmed: 'CR Бронь → Подтверждена (карточка, все сделки)',
  shipment_rate: 'Доля отгруженного от проданного',
};
export const LEGACY_AXIS_DEFAULT_INVERT: Record<LegacyAxisKey, boolean> = {
  cr_deal_to_reservation: false,
  cr_reservation_to_sale: false,
  sales_amount: false,
  avg_check: false,
  touch_speed: true,   // меньше — лучше (сохраняем текущее поведение)
  refusal_rate: true,  // меньше — лучше (сохраняем текущее поведение)
  cr_reservation_to_confirmed: false,
  shipment_rate: false,
};

// Исходные 6 плиток (карточка v1/v2/v3, до задачи 10.07 п.1 «плитки из ВСЕХ метрик»).
// Значения — camelCase (НЕ id каталога метрик) — своя формула в managerCard.ts::
// tileRaw (напр. salesAmount = primary_sales_amount + repeat_sales_amount, суммарно
// по всем сделкам — как и раньше, «Продажи» отчёта считают только PRIMARY-scope,
// поэтому это НЕ то же самое число, что одноимённая метрика каталога, если такая
// появится). Префикс «legacy:» (см. LEGACY_TILE_PREFIX ниже) отделяет эти 6 формул
// от id каталога, даже без буквального совпадения имён — единообразно с осями (п.2).
export const LEGACY_TILE_KEYS = [
  'reservations',
  'confirmedReservations',
  'salesCount',
  'salesAmount',
  'shipments',
  'avgCheck',
] as const;
export type LegacyTileKey = (typeof LEGACY_TILE_KEYS)[number];

export function legacyTileStorageKey(k: LegacyTileKey): string { return `${LEGACY_PREFIX}${k}`; }
export function isLegacyTileStorageKey(k: string): boolean {
  return k.startsWith(LEGACY_PREFIX) && (LEGACY_TILE_KEYS as readonly string[]).includes(k.slice(LEGACY_PREFIX.length));
}
export function stripLegacyTilePrefix(k: string): LegacyTileKey {
  return k.slice(LEGACY_PREFIX.length) as LegacyTileKey;
}

export const LEGACY_TILE_LABELS: Record<LegacyTileKey, string> = {
  reservations: 'Брони',
  confirmedReservations: 'Подтв. брони',
  salesCount: 'Продажи, шт',
  salesAmount: 'Продажи, ₽',
  shipments: 'Отгрузки',
  avgCheck: 'Средний чек',
};

// Оставлено для обратной совместимости импортов (старое имя до задачи 10.07 п.1) —
// новый код должен использовать LEGACY_TILE_KEYS.
export const TILE_CATALOG_KEYS = LEGACY_TILE_KEYS;
export type TileKey = LegacyTileKey;

export interface AxisConfig {
  /** «legacy:<key>» — один из LEGACY_AXIS_KEYS, ИЛИ голый id метрики полного
   *  каталога (lib/metrics/catalog.ts::loadMetrics(), задача 10.07 п.2). */
  metricKey: string;
  /** «Меньше — лучше» — переворачивает перцентильную шкалу при скоринге/отображении.
   *  Дефолт false; у legacy touch_speed/refusal_rate дефолт true (см. DEFAULT_AXES). */
  invert: boolean;
}

export const DEFAULT_AXES: AxisConfig[] = [
  { metricKey: legacyStorageKey('cr_deal_to_reservation'), invert: LEGACY_AXIS_DEFAULT_INVERT.cr_deal_to_reservation },
  { metricKey: legacyStorageKey('cr_reservation_to_sale'), invert: LEGACY_AXIS_DEFAULT_INVERT.cr_reservation_to_sale },
  { metricKey: legacyStorageKey('sales_amount'), invert: LEGACY_AXIS_DEFAULT_INVERT.sales_amount },
  { metricKey: legacyStorageKey('avg_check'), invert: LEGACY_AXIS_DEFAULT_INVERT.avg_check },
  { metricKey: legacyStorageKey('touch_speed'), invert: LEGACY_AXIS_DEFAULT_INVERT.touch_speed },
  { metricKey: legacyStorageKey('refusal_rate'), invert: LEGACY_AXIS_DEFAULT_INVERT.refusal_rate },
];
// Плитки — простой массив storage-ключей («legacy:<6 исходных>» ИЛИ голый id
// каталога), порядок = порядок рендера, БЕЗ ограничения количества (задача 10.07,
// п.1 — «сетка растёт», в отличие от MAX_AXES=6 у осей паутины).
export const DEFAULT_TILES: string[] = LEGACY_TILE_KEYS.map(legacyTileStorageKey);
export const MAX_AXES = 6;

export interface CardTemplate {
  axes: AxisConfig[]; // порядок = порядок осей в паутине, до MAX_AXES
  tiles: string[];    // порядок = порядок плиток итогов, без ограничения количества
}

const DEFAULT_TEMPLATE: CardTemplate = { axes: DEFAULT_AXES, tiles: DEFAULT_TILES };

/**
 * Санитайзер осей для API PUT / чтения из БД. Валидирует metricKey ПРОТИВ живого
 * каталога метрик (loadMetrics(), только видимые: !isHiddenInUi && isActive) —
 * задача 10.07 п.2 сняла фиксированный enum из 8 ключей, поэтому проверка состава
 * больше не статическая (TS-тип), а рантайм-проверка по реальным id из БД.
 * Поддерживает 2 формата на входе (обратная совместимость с данными ДО миграции 075
 * и с в принципе кривыми данными из старого клиента):
 *   - строка (старый формат, миграция 075 переводит существующие строки БД, но
 *     защита не лишняя) — трактуется как legacy-ключ, invert берётся из
 *     LEGACY_AXIS_DEFAULT_INVERT;
 *   - {metricKey, invert} (текущий формат).
 */
export async function sanitizeAxes(raw: unknown): Promise<AxisConfig[]> {
  if (!Array.isArray(raw)) return DEFAULT_AXES;

  const allMetrics = await loadMetrics();
  const validCatalogIds = new Set(allMetrics.filter(m => !m.isHiddenInUi && m.isActive).map(m => m.id));

  const parsed: AxisConfig[] = [];
  for (const entry of raw) {
    let metricKey: string | undefined;
    let invert = false;
    if (typeof entry === 'string') {
      metricKey = entry;
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      if (typeof e.metricKey === 'string') metricKey = e.metricKey;
      if (typeof e.invert === 'boolean') invert = e.invert;
    }
    if (!metricKey) continue;

    if (isLegacyStorageKey(metricKey)) {
      // Явный invert из данных уважаем (админ мог переключить); если поле не было
      // булевым (старый формат — голая строка legacy-ключа БЕЗ префикса, до 075) —
      // фолбэк на исторический дефолт этой оси.
      const bare = metricKey.startsWith(LEGACY_PREFIX) ? metricKey : legacyStorageKey(metricKey as LegacyAxisKey);
      const legacyKey = stripLegacyPrefix(bare);
      parsed.push({ metricKey: bare, invert: typeof entry === 'object' && entry && 'invert' in (entry as object) ? invert : LEGACY_AXIS_DEFAULT_INVERT[legacyKey] });
    } else if ((LEGACY_AXIS_KEYS as readonly string[]).includes(metricKey)) {
      // Голая строка исходного ключа БЕЗ префикса (данные до миграции 075, если она
      // ещё не накатана в этом окружении) — фолбэк на дефолт-invert этой оси.
      parsed.push({ metricKey: legacyStorageKey(metricKey as LegacyAxisKey), invert: LEGACY_AXIS_DEFAULT_INVERT[metricKey as LegacyAxisKey] });
    } else if (validCatalogIds.has(metricKey)) {
      parsed.push({ metricKey, invert });
    }
    // иначе — неизвестный/удалённый из каталога id, молча отбрасываем
  }

  // Дедуп по metricKey (последнее вхождение проигрывает — маловероятно, но не должно падать)
  const seen = new Map<string, AxisConfig>();
  for (const a of parsed) seen.set(a.metricKey, a);
  const clean = [...seen.values()].slice(0, MAX_AXES);
  return clean.length > 0 ? clean : DEFAULT_AXES;
}

/**
 * Санитайзер плиток итогов (задача 10.07, п.1 — «плитки из ВСЕХ метрик каталога»,
 * тот же приём валидации, что и sanitizeAxes, но без invert и без MAX — плитка
 * либо «legacy:<один из 6 исходных>», либо голый id живого каталога метрик.
 * Поддерживает старый формат (голая camelCase-строка БЕЗ префикса, данные до
 * миграции 083) — трактуется как legacy-ключ, фолбэк аналогично sanitizeAxes/075.
 */
export async function sanitizeTiles(raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw)) return DEFAULT_TILES;

  const allMetrics = await loadMetrics();
  const validCatalogIds = new Set(allMetrics.filter(m => !m.isHiddenInUi && m.isActive).map(m => m.id));

  const parsed: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry) continue;
    if (isLegacyTileStorageKey(entry)) {
      parsed.push(entry);
    } else if ((LEGACY_TILE_KEYS as readonly string[]).includes(entry)) {
      // Голая строка исходного ключа БЕЗ префикса (данные до миграции 083)
      parsed.push(legacyTileStorageKey(entry as LegacyTileKey));
    } else if (validCatalogIds.has(entry)) {
      parsed.push(entry);
    }
    // иначе — неизвестный/удалённый из каталога id, молча отбрасываем
  }

  const seen = new Set<string>();
  const clean = parsed.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
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
      value = { axes: await sanitizeAxes(row.axes), tiles: await sanitizeTiles(row.tiles) };
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
