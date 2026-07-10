import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import {
  AXIS_CATALOG_KEYS, TILE_CATALOG_KEYS, MAX_AXES,
  sanitizeAxes, sanitizeTiles, invalidateCardTemplatesCache,
  type TemplateKey, type CatalogAxisKey, type TileKey,
} from '@/lib/settings/cardTemplates';

// Шаблоны карточек (owners-inbox бриф 10.07) — «Карточка менеджера» и «Карточка
// отдела (РОП)»: до 6 осей паутины (из каталога 8) + какие плитки итогов показывать.
// Хранится в card_templates (миграция 073, singleton-по-ключу, как scoring_weights/068).
//
// Гейт — section.settings, БЕЗ superadmin-only (в отличие от /api/settings/scoring-weights
// и /api/settings/daily-plan-mode) — явное решение владельца 10.07: «админ должен видеть
// и менять». Если миграция ещё не накатана — GET отдаёт дефолты (см. getCardTemplate),
// PUT вернёт 500 при попытке записи в отсутствующую таблицу (ожидаемо до наката Артёма).

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

  const res = await systemDb().query<{ axes: unknown; tiles: unknown }>(
    `SELECT axes, tiles FROM card_templates WHERE template_key = $1`,
    [key],
  ).catch(() => ({ rows: [] as { axes: unknown; tiles: unknown }[] }));

  const row = res.rows[0];
  return NextResponse.json({
    key,
    axes: row ? sanitizeAxes(row.axes) : undefined,
    tiles: row ? sanitizeTiles(row.tiles) : undefined,
    catalog: { axes: AXIS_CATALOG_KEYS, tiles: TILE_CATALOG_KEYS, maxAxes: MAX_AXES },
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
    return NextResponse.json({ error: 'axes обязателен (непустой массив, до 6 ключей из каталога)' }, { status: 400 });
  }
  const invalidAxis = (body.axes as unknown[]).find(a => !(AXIS_CATALOG_KEYS as readonly string[]).includes(a as string));
  if (invalidAxis !== undefined) {
    return NextResponse.json({ error: `Неизвестная ось: ${String(invalidAxis)}` }, { status: 400 });
  }
  if ((body.axes as unknown[]).length > MAX_AXES) {
    return NextResponse.json({ error: `Максимум ${MAX_AXES} осей` }, { status: 400 });
  }

  if (!Array.isArray(body.tiles) || body.tiles.length === 0) {
    return NextResponse.json({ error: 'tiles обязателен (непустой массив ключей плиток)' }, { status: 400 });
  }
  const invalidTile = (body.tiles as unknown[]).find(t => !(TILE_CATALOG_KEYS as readonly string[]).includes(t as string));
  if (invalidTile !== undefined) {
    return NextResponse.json({ error: `Неизвестная плитка: ${String(invalidTile)}` }, { status: 400 });
  }

  const axes = sanitizeAxes(body.axes) as CatalogAxisKey[];
  const tiles = sanitizeTiles(body.tiles) as TileKey[];

  await systemDb().query(
    `INSERT INTO card_templates (template_key, axes, tiles, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, NOW())
     ON CONFLICT (template_key) DO UPDATE SET axes = $2::jsonb, tiles = $3::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(axes), JSON.stringify(tiles)],
  );
  invalidateCardTemplatesCache(key);
  return NextResponse.json({ ok: true, key, axes, tiles });
}
