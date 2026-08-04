import { NextRequest, NextResponse } from 'next/server';
import type { Pool, PoolClient } from 'pg';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { getAllRopAndDirectorIds } from '@/lib/org/callControlScope';
import { systemDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';
import { priceEball, recomputeFifoRemaining } from '@/features/badges/engine/wallet';
import { loadXpSettings, levelFromXp } from '@/features/xp/engine/xp';
import { rarityForPrice } from '@/features/shop/engine/rarity';
import { pushViaAnalitik } from '@/features/badges/engine/notifications';
import { actorFromSession, spendPinRequirement, verifyPin } from '@/lib/auth/pin';

// Магазин призов + «Заполнятор товаров» (задача 2960): витрина + покупка +
// свой инвентарь. MLT — единственная валюта покупки (правка владельца
// «продаётся только в MLT»). Покупка = списание из леджера
// source='shop_purchase' + предмет в inventory_items со сроком годности
// ttl_months позиции. Цена фиксируется в момент покупки (price_paid) —
// будущая индексация цен каталога оформленное не трогает.
//
// Гейты покупки (2960, min_level уточнён в 2983):
//  - buyer_scope='rop_only' — товар вообще НЕ показывается тем, кто не РОП/
//    директор (правка владельца: «командные — теперь только у РОПов»);
//  - min_level — товар ВИДЕН всем (мотивирующая цель, карточка заблюрена на
//    витрине с подписью «Доступен с N уровня»), но кнопка покупки
//    заблокирована ниже уровня (levelFromXp, xp_ledger) — ЭТА ЖЕ проверка
//    повторена на бэкенде ниже (POST), не только в UI. С 2983 min_level —
//    ЧИСТО антифарм-защита («чтобы менеджер хитростью за два месяца не
//    нафармил айфон»), редкость от него больше НЕ зависит — редкость теперь
//    считается от ЦЕНЫ, features/shop/engine/rarity.ts (rarityForPrice);
//  - per_person_limit/per_person_limit_days — сколько раз ОДНОМУ человеку
//    можно купить эту позицию за окно (или за всё время, если дней нет).

interface ItemRow {
  id: number; name: string; description: string | null; category: string;
  price_units: string; enabled: boolean;
  stock: number | null; ttl_months: number; sort: number;
  emoji: string; min_level: number; marketplace_url: string | null; buyer_scope: string;
  per_person_limit: number | null; per_person_limit_days: number | null;
  requires_approval: boolean;
  boost_metric: string | null; boost_multiplier: string | null; boost_window_days: number | null; boost_scope: string | null;
  has_image: boolean;
}

async function viewerLevel(db: Pool | PoolClient, bitrixId: number): Promise<number> {
  const [settings, totals] = await Promise.all([
    loadXpSettings(db),
    db.query<{ total: string | null }>(`SELECT sum(total_xp)::text AS total FROM xp_ledger WHERE bitrix_id = $1`, [bitrixId]),
  ]);
  const total = Math.round(Number(totals.rows[0]?.total ?? 0));
  return levelFromXp(total, settings.levelBase, settings.levelExp);
}

// GET: витрина (только enabled, отфильтрованная по buyer_scope зрителя) + инвентарь.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requested = req.nextUrl.searchParams.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (bitrixId && bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = systemDb();
  const [items, currencyName, ropSets] = await Promise.all([
    db.query<ItemRow>(
      `SELECT id::int AS id, name, description, category, price_units,
              enabled, stock, ttl_months, sort,
              emoji, min_level, marketplace_url, buyer_scope,
              per_person_limit, per_person_limit_days, requires_approval,
              boost_metric, boost_multiplier, boost_window_days, boost_scope,
              (image_mime IS NOT NULL) AS has_image
         FROM shop_items WHERE enabled = true ORDER BY category, sort, id`,
    ),
    getCurrencyName(db),
    getAllRopAndDirectorIds(),
  ]);

  // Зритель — тот, чью витрину/инвентарь показываем (bitrixId параметра, или
  // себя). buyer_scope='rop_only' виден только если ОН сам РОП/директор —
  // рядовому менеджеру такие позиции убраны из выдачи целиком (правка
  // владельца), а не просто задизейблены.
  const viewerIsRop = bitrixId !== null && bitrixId !== undefined
    && (ropSets.ropIds.has(bitrixId) || ropSets.directorIds.has(bitrixId));
  const visibleItems = items.rows.filter(i => i.buyer_scope !== 'rop_only' || viewerIsRop);

  const level = bitrixId ? await viewerLevel(db, Number(bitrixId)) : 0;

  // Счётчик покупок этой позиции ЭТИМ зрителем — для UI лимита «куплено N/M».
  const purchaseCounts = bitrixId && visibleItems.length > 0
    ? await db.query<{ shop_item_id: number; n: string }>(
        `SELECT shop_item_id::int AS shop_item_id, count(*) AS n FROM inventory_items
          WHERE bitrix_id = $1 AND shop_item_id = ANY($2::bigint[]) AND status != 'refunded'
          GROUP BY 1`,
        [Number(bitrixId), visibleItems.map(i => i.id)],
      )
    : { rows: [] as { shop_item_id: number; n: string }[] };
  const purchasedByItem = new Map(purchaseCounts.rows.map(r => [r.shop_item_id, Number(r.n)]));

  const inventory = bitrixId
    ? await db.query(
        `SELECT id::int AS id, shop_item_id::int AS shop_item_id, item_name, price_paid, currency, status,
                to_char(purchased_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS purchased_at,
                to_char(expires_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS expires_at,
                activation_comment, resolver_login, resolve_comment, gift_history,
                to_char(resolved_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS resolved_at
           FROM inventory_items WHERE bitrix_id = $1
          ORDER BY (status IN ('owned','activation_requested')) DESC, purchased_at DESC
          LIMIT 100`,
        [Number(bitrixId)],
      )
    : { rows: [] };

  const balances = bitrixId
    ? await db.query<{ currency: string; balance: string }>(
        `SELECT currency, coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger
          WHERE bitrix_id = $1 GROUP BY currency`,
        [Number(bitrixId)],
      )
    : { rows: [] as { currency: string; balance: string }[] };
  const balanceBy = new Map(balances.rows.map(b => [b.currency, Number(b.balance)]));

  return NextResponse.json({
    currencyName,
    balance: balanceBy.get('EBALL') ?? 0,
    rubBalance: balanceBy.get('RUB') ?? 0,
    viewerLevel: level,
    viewerIsRop,
    items: visibleItems.map(i => {
      const price = priceEball(Number(i.price_units));
      // Редкость — от ЦЕНЫ (правка владельца 04.08, задача 2983), min_level —
      // отдельная антифарм-защита, больше не влияет на бейдж/цвет карточки.
      const rarity = rarityForPrice(price);
      return {
        id: i.id, name: i.name, description: i.description, category: i.category,
        emoji: i.emoji, priceEball: price,
        stock: i.stock, ttlMonths: i.ttl_months,
        minLevel: i.min_level, marketplaceUrl: i.marketplace_url, buyerScope: i.buyer_scope,
        perPersonLimit: i.per_person_limit, perPersonLimitDays: i.per_person_limit_days,
        purchasedByViewer: purchasedByItem.get(i.id) ?? 0,
        requiresApproval: i.requires_approval,
        boostMetric: i.boost_metric, boostMultiplier: i.boost_multiplier !== null ? Number(i.boost_multiplier) : null,
        boostWindowDays: i.boost_window_days, boostScope: i.boost_scope,
        rarityKey: rarity.key, rarityLabel: rarity.label, rarityColor: rarity.color,
        hasImage: i.has_image,
      };
    }),
    inventory: inventory.rows,
  });
}

// POST: покупка {itemId} — только за себя (session.bitrixUserId), только MLT.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { itemId?: unknown; pin?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const itemId = body.itemId;
  if (typeof itemId !== 'number' || !Number.isInteger(itemId)) {
    return NextResponse.json({ error: 'itemId обязателен' }, { status: 400 });
  }

  const id = Number(session.bitrixUserId);
  const db = systemDb();

  // Пин по личному порогу (задача #2995): цена — только MLT в этом эндпоинте
  // (RUB-покупки в магазине выключены владельцем, см. комментарий в шапке файла).
  // Лёгкий пре-чек цены БЕЗ блокировки строки — решить, нужен ли пин, ДО того как
  // открывать денежную транзакцию (verifyPin пишет свою). Реальная цена
  // перепроверяется ниже под FOR UPDATE — если разошлась и это меняет требование
  // пина, покупка отклоняется 409 (реже, чем гипотетическая гонка админской правки цены).
  const probe = await db.query<{ price_units: string }>(`SELECT price_units FROM shop_items WHERE id = $1`, [itemId]);
  if (!probe.rows.length) return NextResponse.json({ error: 'Позиция не найдена или выключена' }, { status: 404 });
  const probePrice = priceEball(Number(probe.rows[0].price_units));
  const actor = actorFromSession(session, req);
  const need = await spendPinRequirement(db, id, probePrice);
  let pinEventId: number | null = null;
  if (need.required) {
    const verified = await verifyPin(db, actor, body.pin, {
      operation: 'shop_purchase', targetRef: String(itemId), amount: probePrice, currency: 'EBALL',
    });
    if (!verified.ok) return NextResponse.json({ error: verified.error, pinRequired: true, reason: need.reason }, { status: verified.status });
    pinEventId = verified.pinEventId;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Блокируем позицию: конкурентные покупки последней штуки со склада.
    const itemRes = await client.query<ItemRow>(
      `SELECT id::int AS id, name, description, category, price_units,
              enabled, stock, ttl_months, sort,
              emoji, min_level, marketplace_url, buyer_scope,
              per_person_limit, per_person_limit_days, requires_approval,
              boost_metric, boost_multiplier, boost_window_days, boost_scope
         FROM shop_items WHERE id = $1 FOR UPDATE`,
      [itemId],
    );
    const item = itemRes.rows[0];
    if (!item || !item.enabled) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Позиция не найдена или выключена' }, { status: 404 });
    }
    if (item.stock !== null && item.stock <= 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Позиция закончилась' }, { status: 400 });
    }

    // Кто может покупать (правка владельца: командные — только РОП/директор).
    if (item.buyer_scope === 'rop_only') {
      const ropSets = await getAllRopAndDirectorIds();
      const bid = String(id);
      if (!ropSets.ropIds.has(bid) && !ropSets.directorIds.has(bid)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Эта позиция доступна только руководителям' }, { status: 403 });
      }
    }

    // Минимальный уровень (редкость завязана на тот же порог).
    const level = await viewerLevel(client, id);
    if (level < item.min_level) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: `Нужен уровень ${item.min_level} (у вас ${level})` }, { status: 403 });
    }

    // Лимит на человека — за окно в днях, или за всё время, если окно не задано.
    if (item.per_person_limit !== null) {
      const windowSql = item.per_person_limit_days !== null
        ? `AND purchased_at >= now() - make_interval(days => ${Number(item.per_person_limit_days)})`
        : '';
      const cnt = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM inventory_items
          WHERE bitrix_id = $1 AND shop_item_id = $2 AND status != 'refunded' ${windowSql}`,
        [id, itemId],
      );
      if (Number(cnt.rows[0]?.n ?? 0) >= item.per_person_limit) {
        await client.query('ROLLBACK');
        const period = item.per_person_limit_days !== null ? ` за последние ${item.per_person_limit_days} дн.` : ' на человека';
        return NextResponse.json({ error: `Лимит покупок исчерпан: ${item.per_person_limit}${period}` }, { status: 400 });
      }
    }

    const price = priceEball(Number(item.price_units));
    // Цена изменилась между пре-чеком пина и блокировкой строки, и требование
    // сменилось (теперь нужен пин, а мы его не спросили/не проверили) — просим
    // повторить, а не молча пропускаем списание без пина.
    if (!pinEventId && price !== probePrice) {
      const recheck = await spendPinRequirement(client, id, price);
      if (recheck.required) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Цена позиции изменилась — повторите покупку', pinRequired: true }, { status: 409 });
      }
    }
    const bal = await client.query<{ balance: string }>(
      `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger WHERE bitrix_id = $1 AND currency = 'EBALL'`,
      [id],
    );
    const balance = Number(bal.rows[0]?.balance ?? 0);
    if (price > balance) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: `Не хватает средств: цена ${price}, на балансе ${balance}` }, { status: 400 });
    }

    if (item.stock !== null) {
      await client.query(`UPDATE shop_items SET stock = stock - 1, updated_at = now() WHERE id = $1`, [itemId]);
    }
    // requires_approval=false — сразу used (мгновенная позиция, без заявки
    // руководителю); true (дефолт, как раньше у ВСЕХ) — owned, активация заявкой.
    const initialStatus = item.requires_approval ? 'owned' : 'used';
    const inv = await client.query<{ id: number }>(
      `INSERT INTO inventory_items (bitrix_id, shop_item_id, item_name, price_paid, currency, expires_at, status,
                                     resolved_at, resolve_comment)
       VALUES ($1, $2, $3, $4, 'EBALL', now() + make_interval(months => $5), $6,
               CASE WHEN $6 = 'used' THEN now() END,
               CASE WHEN $6 = 'used' THEN 'Без подтверждения руководителя — выдаётся сразу' END)
       RETURNING id`,
      [id, itemId, item.name, price, item.ttl_months, initialStatus],
    );
    const led = await client.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, comment, inventory_item_id, pin_event_id)
       VALUES ($1, $2, $3, 'EBALL', 'shop_purchase', $4, $5, $6) RETURNING id`,
      [id, -price, price, `Покупка в магазине: ${item.name}`, inv.rows[0].id, pinEventId],
    );
    await client.query(`UPDATE inventory_items SET ledger_id = $2 WHERE id = $1`, [inv.rows[0].id, led.rows[0].id]);
    // FIFO (TTL MLT): списание расходует старейшие живые начисления —
    // точечный пересчёт остатков лотов покупателя в той же транзакции.
    await recomputeFifoRemaining(client, id);
    // Название валюты — ДО коммита, пока client ещё жив (после client.release()
    // в finally соединение уходит обратно в пул — использовать client после
    // COMMIT нельзя, гонка с чужим запросом).
    const unit = await getCurrencyName(client);
    await client.query('COMMIT');
    // Пуш «Аналитиком» (задача 2759, п.4) — ПОСЛЕ коммита, best-effort. Общий
    // для material/immaterial/boost — сообщение не ветвится по типу, поэтому
    // новые типы позиций уже покрыты без отдельного текста на каждый.
    void pushViaAnalitik(id, `🛍️ Покупка в магазине: ${item.name}`,
      initialStatus === 'used'
        ? `−${price} ${unit}. Выдано сразу — подтверждение руководителя не требуется.`
        : `−${price} ${unit}. Срок годности ${item.ttl_months} мес — в табе «Инвентарь».`);
    return NextResponse.json({ ok: true, inventoryId: inv.rows[0].id, paid: price, currency: 'EBALL' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
