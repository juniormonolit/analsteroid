import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { priceEball } from '@/features/badges/engine/wallet';
import { rarityForPrice } from '@/features/shop/engine/rarity';
import { graphemeClusters } from '@/lib/text/graphemes';
import { decodeUploadedImage } from '@/lib/images/shopItemImage';

// Управление каталогом магазина — «Заполнятор товаров» (задача 2960, ТЗ Серёги
// 04.08: «хочу заводить всё сам» — эмодзи вместо фото, тип/ссылка на
// маркетплейс «для примера», кто может покупать, лимит на человека,
// подтверждение при активации, поля буста). Той же формой заводятся
// и бусты (item_type='boost') — просто с дополнительными полями буста.
// Редкость (правка владельца 04.08, задача 2983) считается от ЦЕНЫ товара —
// rarityForPrice(priceEball), features/shop/engine/rarity.ts. min_level —
// «порог доступности», отдельная антифарм-защита («чтобы менеджер хитростью
// за два месяца не нафармил айфон»), НЕ влияет на редкость.
//
// MLT — единственная валюта покупки (правка владельца): allowed_currencies
// колонку не трогаем структурно (история/задел), но форма больше не даёт
// выбрать RUB — новые/отредактированные позиции всегда '{EBALL}'.
// Цены — в единицах индексации (см. миграцию 118 / wallet.ts). Удаления нет —
// только выключение (enabled), история покупок ссылается на позиции.

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const db = systemDb();
  const [items, settings] = await Promise.all([
    db.query(
      `SELECT i.id::int AS id, i.name, i.description, i.category, i.price_units,
              i.enabled, i.stock, i.ttl_months, i.sort,
              i.emoji, i.min_level, i.marketplace_url, i.buyer_scope,
              i.per_person_limit, i.per_person_limit_days, i.requires_approval, i.cost_rub,
              i.boost_metric, i.boost_multiplier, i.boost_window_days, i.boost_scope,
              (i.image_mime IS NOT NULL) AS has_image,
              coalesce(p.purchases, 0)::int AS purchases
         FROM shop_items i
         LEFT JOIN (SELECT shop_item_id, count(*) AS purchases FROM inventory_items GROUP BY 1) p
           ON p.shop_item_id = i.id
        ORDER BY i.category, i.sort, i.id`,
    ),
    db.query<{ ttl_months: number; fee: string; tlim: number }>(
      `SELECT ttl_months, transfer_fee_percent AS fee, transfer_daily_limit AS tlim
         FROM badge_coin_settings WHERE id = 1`,
    ),
  ]);
  return NextResponse.json({
    // Курс MLT→₽ (миграция 153) — редактор считает по нему цену из себестоимости.
    mltRate: Number((await systemDb().query('SELECT COALESCE(mlt_rub_rate, 5) r FROM badge_coin_settings WHERE id = 1')).rows[0]?.r ?? 5),
    coinTtlMonths: settings.rows[0]?.ttl_months ?? 6,
    // Комиссия/лимит переводов MLT между коллегами — отдельная фича (не про
    // цены каталога, RUB здесь ни при чём), ShopSettingsBlock читает её ОТСЮДА
    // же — не убирать при чистке RUB-полей витрины.
    transferFeePercent: Number(settings.rows[0]?.fee ?? 5),
    transferDailyLimit: settings.rows[0]?.tlim ?? 500,
    items: items.rows.map(i => {
      const minLevel = Number(i.min_level);
      const price = priceEball(Number(i.price_units));
      // Редкость — от ЦЕНЫ (правка владельца 04.08, задача 2983), min_level —
      // отдельная антифарм-защита ( «порог доступности»), больше не влияет на
      // бейдж/цвет редкости.
      const rarity = rarityForPrice(price);
      return {
        id: i.id, name: i.name, description: i.description, category: i.category,
        priceUnits: Number(i.price_units), priceEball: price,
        enabled: i.enabled, stock: i.stock,
        ttlMonths: i.ttl_months, sort: i.sort, purchases: i.purchases,
        emoji: i.emoji, minLevel, marketplaceUrl: i.marketplace_url,
        buyerScope: i.buyer_scope,
        perPersonLimit: i.per_person_limit, perPersonLimitDays: i.per_person_limit_days,
        requiresApproval: i.requires_approval,
        costRub: i.cost_rub === null ? null : Number(i.cost_rub),
        boostMetric: i.boost_metric, boostMultiplier: i.boost_multiplier !== null ? Number(i.boost_multiplier) : null,
        boostWindowDays: i.boost_window_days, boostScope: i.boost_scope,
        rarityKey: rarity.key, rarityLabel: rarity.label, rarityColor: rarity.color,
        // Своя картинка (задача 2994) — байты НЕ гоняем в этом ответе, только
        // флаг; сама картинка — GET /api/shop-item-image/[id] (кэшируемо).
        hasImage: Boolean(i.has_image),
      };
    }),
  });
}

// Своя картинка (задача 2994) — три состояния правки:
//  - 'keep'   — не трогать то, что уже сохранено (PATCH без поля image);
//  - 'remove' — явно вернуться к эмодзи (image: null в body);
//  - 'set'    — сохранить новые байты (image: {mime, dataBase64} в body,
//    ПРИШЕДШИЕ либо из файла с клиента, либо из /fetch-image-url).
type ImageAction =
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'set'; mime: string; buffer: Buffer };

interface ItemInput {
  name: string; description: string | null; category: 'material' | 'immaterial' | 'boost' | 'team';
  priceUnits: number; stock: number | null; ttlMonths: number; sort: number;
  emoji: string; minLevel: number; marketplaceUrl: string | null;
  buyerScope: 'all' | 'rop_only';
  perPersonLimit: number | null; perPersonLimitDays: number | null;
  requiresApproval: boolean;
  /** Себестоимость для компании, ₽ (миграция 155). null — не задана. */
  costRub: number | null;
  boostMetric: string | null; boostMultiplier: number | null; boostWindowDays: number | null; boostScope: string | null;
  image: ImageAction;
}

// Фолбэк-эмодзи, если поле пустое/не пришло — «просто поле для эмодзи», не
// обязываем администратора вводить символ, если он спешит.
const DEFAULT_EMOJI = '🎁';
// Потолок ДО графемной сегментации — защита от мегабайтного paste, чтобы не
// гонять Intl.Segmenter по гигантской строке. Сама «одно эмодзи» проверка —
// в графемах ниже, не в code unit'ах (задача 2994, флаги/ZWJ/тон кожи).
const EMOJI_RAW_SAFETY_CAP = 256;
const EMOJI_MAX_GRAPHEMES = 8;

function validate(body: Record<string, unknown>): ItemInput | string {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 300) : '';
  if (!name) return 'Название не может быть пустым';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 1000) || null : null;
  // Себестоимость (миграция 155): не задана — null (дашборд тогда оценивает
  // затраты по цене продажи и честно предупреждает, что это оценка сверху).
  const costRaw = body.costRub;
  if (costRaw !== undefined && costRaw !== null && costRaw !== '' &&
      (typeof costRaw !== 'number' || !Number.isFinite(costRaw) || costRaw < 0)) {
    return 'Себестоимость — число не меньше нуля';
  }
  const costRub = typeof costRaw === 'number' ? costRaw : null;
  const category = body.category;
  if (category !== 'material' && category !== 'immaterial' && category !== 'boost' && category !== 'team') {
    return 'Тип позиции: material | immaterial | boost';
  }
  const priceUnits = body.priceUnits;
  if (typeof priceUnits !== 'number' || !Number.isFinite(priceUnits) || priceUnits <= 0 || priceUnits > 1_000_000) {
    return 'Цена — число больше нуля (в единицах, сейчас 1 ед = 1 MLT)';
  }
  const stock = body.stock === null || body.stock === undefined || body.stock === ''
    ? null : Number(body.stock);
  if (stock !== null && (!Number.isInteger(stock) || stock < 0)) return 'Сток — целое ≥ 0 или пусто (безлимит)';
  const ttlMonths = body.ttlMonths === undefined ? 3 : Number(body.ttlMonths);
  if (!Number.isInteger(ttlMonths) || ttlMonths <= 0 || ttlMonths > 60) return 'Срок годности — целое число месяцев 1–60';
  const sort = body.sort === undefined ? 100 : Number(body.sort);
  if (!Number.isInteger(sort)) return 'Сортировка — целое число';

  // Эмодзи «вместо фото» (задача 2994: поле должно принимать ЛЮБОЙ символ из
  // копипасты, включая составные — флаги/тон кожи/ZWJ-семьи — не разрезая их
  // пополам). Считаем и режем ГРАФЕМАМИ (Intl.Segmenter), а не .length —
  // тот же lib/text/graphemes.ts, что и на клиенте (превью=сохранение).
  const emojiRawInput = typeof body.emoji === 'string' ? body.emoji.trim() : '';
  if (emojiRawInput.length > EMOJI_RAW_SAFETY_CAP) {
    return `Эмодзи — слишком длинная вставка (это не поле для текста)`;
  }
  const emojiGraphemes = graphemeClusters(emojiRawInput).slice(0, EMOJI_MAX_GRAPHEMES);
  const emoji = emojiGraphemes.length > 0 ? emojiGraphemes.join('') : DEFAULT_EMOJI;

  // Своя картинка — файл (клиент прислал base64) или ссылка (уже скачана
  // клиентом через /fetch-image-url, тут только base64 дошедших байт).
  // image === undefined → 'keep' (PATCH ничего не меняет в картинке);
  // image === null → 'remove' (вернуться к эмодзи);
  // image === {mime, dataBase64} → 'set' (проверяем сигнатуру/размер СНОВА —
  // не доверяем тому, что клиент/предыдущий роут уже проверили).
  let image: ImageAction = { kind: 'keep' };
  if (body.image === null) {
    image = { kind: 'remove' };
  } else if (body.image && typeof body.image === 'object') {
    const img = body.image as { dataBase64?: unknown };
    if (typeof img.dataBase64 !== 'string' || !img.dataBase64) {
      return 'Картинка: некорректные данные';
    }
    const decoded = decodeUploadedImage(img.dataBase64);
    if (typeof decoded === 'string') return `Картинка: ${decoded}`;
    image = { kind: 'set', mime: decoded.mime, buffer: decoded.buffer };
  }

  const minLevel = body.minLevel === undefined ? 0 : Number(body.minLevel);
  if (!Number.isInteger(minLevel) || minLevel < 0 || minLevel > 200) return 'Минимальный уровень — целое число 0–200';

  let marketplaceUrl: string | null = null;
  if (typeof body.marketplaceUrl === 'string' && body.marketplaceUrl.trim()) {
    const v = body.marketplaceUrl.trim();
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
      marketplaceUrl = v.slice(0, 2000);
    } catch {
      return 'Ссылка на маркетплейс — некорректный URL (нужен http(s)://...)';
    }
  }

  const buyerScope = body.buyerScope;
  if (buyerScope !== 'all' && buyerScope !== 'rop_only') return 'Кто может покупать: all | rop_only';

  const perPersonLimit = body.perPersonLimit === null || body.perPersonLimit === undefined || body.perPersonLimit === ''
    ? null : Number(body.perPersonLimit);
  if (perPersonLimit !== null && (!Number.isInteger(perPersonLimit) || perPersonLimit <= 0)) {
    return 'Лимит на человека — целое число больше нуля или пусто (без лимита)';
  }
  const perPersonLimitDays = body.perPersonLimitDays === null || body.perPersonLimitDays === undefined || body.perPersonLimitDays === ''
    ? null : Number(body.perPersonLimitDays);
  if (perPersonLimitDays !== null && (!Number.isInteger(perPersonLimitDays) || perPersonLimitDays <= 0)) {
    return 'Окно лимита (дней) — целое число больше нуля или пусто (лимит на всё время)';
  }

  const requiresApproval = body.requiresApproval !== false; // дефолт true, как раньше у ВСЕХ позиций

  let boostMetric: string | null = null;
  let boostMultiplier: number | null = null;
  let boostWindowDays: number | null = null;
  let boostScope: string | null = null;
  if (category === 'boost') {
    boostMetric = typeof body.boostMetric === 'string' ? body.boostMetric.trim().slice(0, 200) || null : null;
    if (body.boostMultiplier !== undefined && body.boostMultiplier !== null && body.boostMultiplier !== '') {
      boostMultiplier = Number(body.boostMultiplier);
      if (!Number.isFinite(boostMultiplier) || boostMultiplier <= 0 || boostMultiplier > 100) {
        return 'Множитель буста — число больше нуля (например 1.5 = ×1.5)';
      }
    }
    if (body.boostWindowDays !== undefined && body.boostWindowDays !== null && body.boostWindowDays !== '') {
      boostWindowDays = Number(body.boostWindowDays);
      if (!Number.isInteger(boostWindowDays) || boostWindowDays <= 0 || boostWindowDays > 365) {
        return 'Длительность окна буста — целое число дней 1–365';
      }
    }
    boostScope = typeof body.boostScope === 'string' ? body.boostScope.trim().slice(0, 200) || null : null;
  }

  return {
    name, description, category, priceUnits, stock, ttlMonths, sort,
    emoji, minLevel, marketplaceUrl, buyerScope,
    perPersonLimit, perPersonLimitDays, requiresApproval, costRub,
    boostMetric, boostMultiplier, boostWindowDays, boostScope,
    image,
  };
}

export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const v = validate(body);
  if (typeof v === 'string') return NextResponse.json({ error: v }, { status: 400 });
  // Новая позиция: image.kind — 'set' (сохранить присланные байты) либо
  // 'keep'/'remove' (в обоих случаях — нет своей картинки, эмодзи).
  const imageMime = v.image.kind === 'set' ? v.image.mime : null;
  const imageData = v.image.kind === 'set' ? v.image.buffer : null;
  const r = await systemDb().query<{ id: number }>(
    `INSERT INTO shop_items (
       name, description, category, price_units, allowed_currencies, stock, ttl_months, sort,
       emoji, min_level, marketplace_url, buyer_scope, per_person_limit, per_person_limit_days,
       requires_approval, boost_metric, boost_multiplier, boost_window_days, boost_scope,
       image_mime, image_data, cost_rub
     )
     VALUES ($1,$2,$3,$4,'{EBALL}',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
    [v.name, v.description, v.category, v.priceUnits, v.stock, v.ttlMonths, v.sort,
     v.emoji, v.minLevel, v.marketplaceUrl, v.buyerScope, v.perPersonLimit, v.perPersonLimitDays,
     v.requiresApproval, v.boostMetric, v.boostMultiplier, v.boostWindowDays, v.boostScope,
     imageMime, imageData, v.costRub],
  );
  return NextResponse.json({ ok: true, id: r.rows[0].id });
}

// PATCH: {id, ...поля} — правка позиции или переключение enabled.
export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const id = body.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return NextResponse.json({ error: 'id обязателен' }, { status: 400 });

  // Быстрый тумблер enabled без остальных полей (видимость на витрине — без
  // удаления, история покупок сохраняется).
  if (typeof body.enabled === 'boolean' && body.name === undefined) {
    const r = await systemDb().query(
      `UPDATE shop_items SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING id`, [id, body.enabled],
    );
    if (r.rowCount === 0) return NextResponse.json({ error: 'Позиция не найдена' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  const v = validate(body);
  if (typeof v === 'string') return NextResponse.json({ error: v }, { status: 400 });
  // Картинка — три состояния (задача 2994): $21 — действие ('keep' не трогает
  // image_mime/image_data вообще, 'remove' обнуляет оба, 'set' пишет новые
  // байты) — CASE в SQL, а не JS-ветвление запроса, чтобы не городить
  // динамическую сборку SQL-строки для одного поля.
  const r = await systemDb().query(
    `UPDATE shop_items
        SET name = $2, description = $3, category = $4, price_units = $5,
            allowed_currencies = '{EBALL}', stock = $6, ttl_months = $7, sort = $8,
            enabled = coalesce($9, enabled), updated_at = now(),
            emoji = $10, min_level = $11, marketplace_url = $12, buyer_scope = $13,
            per_person_limit = $14, per_person_limit_days = $15, requires_approval = $16,
            boost_metric = $17, boost_multiplier = $18, boost_window_days = $19, boost_scope = $20,
            image_mime = CASE $21::text WHEN 'set' THEN $22::text WHEN 'remove' THEN NULL ELSE image_mime END,
            image_data = CASE $21::text WHEN 'set' THEN $23::bytea WHEN 'remove' THEN NULL ELSE image_data END,
            cost_rub = $24
      WHERE id = $1 RETURNING id`,
    [id, v.name, v.description, v.category, v.priceUnits,
     v.stock, v.ttlMonths, v.sort, typeof body.enabled === 'boolean' ? body.enabled : null,
     v.emoji, v.minLevel, v.marketplaceUrl, v.buyerScope, v.perPersonLimit, v.perPersonLimitDays,
     v.requiresApproval, v.boostMetric, v.boostMultiplier, v.boostWindowDays, v.boostScope,
     v.image.kind, v.image.kind === 'set' ? v.image.mime : null, v.image.kind === 'set' ? v.image.buffer : null,
     v.costRub],
  );
  if (r.rowCount === 0) return NextResponse.json({ error: 'Позиция не найдена' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
