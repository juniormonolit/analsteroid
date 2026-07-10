import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import {
  MAX_AXES, LEGACY_AXIS_KEYS, LEGACY_AXIS_LABELS, LEGACY_AXIS_DEFAULT_INVERT,
  LEGACY_TILE_KEYS, LEGACY_TILE_LABELS,
  legacyStorageKey, isLegacyStorageKey,
  legacyTileStorageKey, isLegacyTileStorageKey,
  sanitizeAxes, sanitizeTiles, invalidateCardTemplatesCache,
  type TemplateKey, type AxisConfig,
} from '@/lib/settings/cardTemplates';

// Шаблоны карточек (owners-inbox бриф 10.07, задача 10.07 п.2 «оси из ВСЕХ метрик»,
// карточка v4 п.1 «плитки из ВСЕХ метрик») — «Карточка менеджера» и «Карточка
// отдела (РОП)»: до 6 осей паутины ИЗ ПОЛНОГО каталога метрик (не 8 зашитых) +
// плитки итогов ИЗ ПОЛНОГО каталога метрик (не 6 зашитых чекбоксов, без
// ограничения количества, порядок настраивается). Хранится в card_templates
// (миграция 073, оси расширены 075, плитки расширены 083), singleton-по-ключу.
//
// Гейт — section.settings, БЕЗ superadmin-only (явное решение владельца 10.07:
// «админ должен видеть и менять»). Если миграции ещё не накатаны — GET отдаёт
// дефолты (см. getCardTemplate/sanitizeAxes/sanitizeTiles), PUT вернёт 500 при
// попытке записи (ожидаемо).

function isTemplateKey(v: string | null): v is TemplateKey {
  return v === 'manager' || v === 'department';
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const key = req.nextUrl.searchParams.get('key');
  if (!isTemplateKey(key)) {
    return NextResponse.json({ error: 'key must be "manager" or "department"' }, { status: 400 });
  }

  const [res, allMetrics] = await Promise.all([
    systemDb().query<{ axes: unknown; tiles: unknown }>(
      `SELECT axes, tiles FROM card_templates WHERE template_key = $1`,
      [key],
    ).catch(() => ({ rows: [] as { axes: unknown; tiles: unknown }[] })),
    loadMetrics(),
  ]);

  const row = res.rows[0];

  // Полный каталог для UI-пикера (задача 10.07, п.2 + карточка v4 п.1): legacy-
  // «бонусные» оси/плитки (те же исходные ключи, что были зашиты раньше — для
  // совместимости и знакомого набора по умолчанию) + ВСЕ видимые метрики каталога,
  // сгруппированные по категории. Только видимые (!isHiddenInUi && isActive) —
  // служебные/скрытые компоненты формул выбрать осью/плиткой нельзя (как и раньше
  // молчаливо не показывались). Оси и плитки используют ОДИН и тот же список
  // metrics — пикер на странице настроек переиспользует один каталог для обоих.
  const visibleMetrics = allMetrics.filter(m => !m.isHiddenInUi && m.isActive);
  const catalog = {
    legacyAxes: LEGACY_AXIS_KEYS.map(k => ({
      metricKey: legacyStorageKey(k),
      label: LEGACY_AXIS_LABELS[k],
      defaultInvert: LEGACY_AXIS_DEFAULT_INVERT[k],
    })),
    legacyTiles: LEGACY_TILE_KEYS.map(k => ({
      metricKey: legacyTileStorageKey(k),
      label: LEGACY_TILE_LABELS[k],
    })),
    metrics: visibleMetrics.map(m => ({ id: m.id, nameRu: m.nameRu, category: m.category, dataType: m.dataType })),
    maxAxes: MAX_AXES,
    // Плитки — без maxTiles (задача 10.07 карточка v4, п.1: «количество НЕ ограничено»).
  };

  // Всегда отдаём санитайзенные оси/плитки (даже без строки в БД — sanitizeAxes/
  // sanitizeTiles сами фолбэчат на дефолтные 6 при !Array.isArray) — раньше GET
  // отдавал undefined без строки, клиент сам подставлял дефолт; теперь дефолт
  // единый источник правды (cardTemplates.ts), не дублируется в клиентском коде.
  return NextResponse.json({
    key,
    axes: await sanitizeAxes(row?.axes),
    tiles: await sanitizeTiles(row?.tiles),
    catalog,
  });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const body = await req.json().catch(() => ({})) as { key?: string; axes?: unknown; tiles?: unknown };
  if (!isTemplateKey(body.key ?? null)) {
    return NextResponse.json({ error: 'key must be "manager" or "department"' }, { status: 400 });
  }
  const key = body.key as TemplateKey;

  if (!Array.isArray(body.axes) || body.axes.length === 0) {
    return NextResponse.json({ error: 'axes обязателен (непустой массив, до 6 осей)' }, { status: 400 });
  }
  if ((body.axes as unknown[]).length > MAX_AXES) {
    return NextResponse.json({ error: `Максимум ${MAX_AXES} осей` }, { status: 400 });
  }

  // Строгая валидация КАЖДОЙ оси/плитки против живого каталога (в отличие от
  // sanitizeAxes/sanitizeTiles, которые молча отбрасывают мусор при ЧТЕНИИ —
  // здесь на ЗАПИСИ хотим внятную ошибку с конкретным неверным id).
  const allMetrics = await loadMetrics();
  const validCatalogIds = new Set(allMetrics.filter(m => !m.isHiddenInUi && m.isActive).map(m => m.id));

  const axes: AxisConfig[] = [];
  for (const entry of body.axes as unknown[]) {
    if (!entry || typeof entry !== 'object') {
      return NextResponse.json({ error: `Некорректная ось: ${JSON.stringify(entry)}` }, { status: 400 });
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.metricKey !== 'string') {
      return NextResponse.json({ error: `Ось без metricKey: ${JSON.stringify(entry)}` }, { status: 400 });
    }
    const invert = typeof e.invert === 'boolean' ? e.invert : false;
    if (isLegacyStorageKey(e.metricKey)) {
      axes.push({ metricKey: e.metricKey, invert });
    } else if (validCatalogIds.has(e.metricKey)) {
      axes.push({ metricKey: e.metricKey, invert });
    } else {
      return NextResponse.json({ error: `Неизвестная метрика: ${e.metricKey}` }, { status: 400 });
    }
  }
  // Дедуп по metricKey (сохраняя порядок первого вхождения)
  const seen = new Set<string>();
  const dedupAxes = axes.filter(a => (seen.has(a.metricKey) ? false : (seen.add(a.metricKey), true)));
  if (dedupAxes.length === 0) {
    return NextResponse.json({ error: 'Выберите хотя бы одну ось' }, { status: 400 });
  }

  // Плитки итогов (задача 10.07 карточка v4, п.1): произвольная длина (без MAX,
  // в отличие от осей), каждая — «legacy:<один из 6 исходных>» либо голый id
  // живого каталога метрик; порядок = порядок в присланном массиве.
  if (!Array.isArray(body.tiles) || body.tiles.length === 0) {
    return NextResponse.json({ error: 'tiles обязателен (непустой массив ключей плиток)' }, { status: 400 });
  }
  const tiles: string[] = [];
  for (const entry of body.tiles as unknown[]) {
    if (typeof entry !== 'string' || !entry) {
      return NextResponse.json({ error: `Некорректная плитка: ${JSON.stringify(entry)}` }, { status: 400 });
    }
    if (isLegacyTileStorageKey(entry) || validCatalogIds.has(entry)) {
      tiles.push(entry);
    } else {
      return NextResponse.json({ error: `Неизвестная плитка: ${entry}` }, { status: 400 });
    }
  }
  const seenTiles = new Set<string>();
  const dedupTiles = tiles.filter(t => (seenTiles.has(t) ? false : (seenTiles.add(t), true)));
  if (dedupTiles.length === 0) {
    return NextResponse.json({ error: 'Выберите хотя бы одну плитку' }, { status: 400 });
  }

  await systemDb().query(
    `INSERT INTO card_templates (template_key, axes, tiles, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, NOW())
     ON CONFLICT (template_key) DO UPDATE SET axes = $2::jsonb, tiles = $3::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(dedupAxes), JSON.stringify(dedupTiles)],
  );
  invalidateCardTemplatesCache(key);
  return NextResponse.json({ ok: true, key, axes: dedupAxes, tiles: dedupTiles });
}
