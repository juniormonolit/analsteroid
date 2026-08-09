import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Коллекция ачивок (задача владельца 05.08: «раздел „Награды“ должен быть только
// про награды… у наград должна быть редкость (частота встречаемости у других)…
// в конце списка блеклые неполученные… вверху счётчик по тирам»).
//
// РЕДКОСТЬ считается ЧЕСТНО и на лету: доля менеджеров, у которых награда есть,
// от числа тех, у кого есть хоть одна награда вообще (знаменатель — «играющие»,
// а не весь ростер: иначе логисты и служебные аккаунты раздували бы редкость).
// Порог редкости — перцентиль владения, не выдумка:
//   ≤5% — легендарная, ≤15% — эпическая, ≤35% — редкая, ≤65% — необычная, иначе обычная.
//
// СЕКРЕТНЫЕ (is_secret, миграция 152) в список неполученных НЕ попадают — они
// появляются только у того, кто их получил. Доступ — любой залогиненный (раздел
// «Награды» публичен, как и профиль).

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface CollectionItem {
  key: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  tiered: boolean;
  isSecret: boolean;
  /** Собран ли комплект-условие (для set_of), иначе null. */
  setOf: string[];
  owned: boolean;
  /** Цена в MLT (максимум по тирам). 0 — за неё не платят. */
  price: number;
  /** true — НАГРАДА (платят MLT), false — АЧИВКА (только статус). Задача 63, п.5. */
  paid: boolean;
  count: number;                 // сколько раз получена этим человеком
  ownersPct: number;             // % владельцев среди «играющих»
  rarity: Rarity;
  lastAwardedAt: string | null;
}

function rarityOf(pct: number): Rarity {
  if (pct <= 5) return 'legendary';
  if (pct <= 15) return 'epic';
  if (pct <= 35) return 'rare';
  if (pct <= 65) return 'uncommon';
  return 'common';
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requested = req.nextUrl.searchParams.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!bitrixId) return NextResponse.json({ items: [], totals: null });
  const id = Number(bitrixId);

  const db = systemDb();
  const [defsRes, mineRes, ownersRes, playersRes, pricesRes] = await Promise.all([
    db.query<{
      key: string; name: string; description: string; icon: string; category: string;
      tiered: boolean; is_secret: boolean; set_of: string[]; criteria: Record<string, unknown> | null;
    }>(
      `SELECT key, name, description, icon, category, tiered,
              COALESCE(is_secret, false) AS is_secret, COALESCE(set_of, '{}') AS set_of, criteria
         FROM badge_definitions
        WHERE enabled IS NOT false
        ORDER BY sort_order, name`,
    ).catch(() => ({ rows: [] as never[] })),
    db.query<{ badge_key: string; n: string; last_at: string | null }>(
      `SELECT badge_key, count(*)::text AS n, max(awarded_at)::text AS last_at
         FROM badge_awards WHERE bitrix_id = $1 GROUP BY 1`,
      [id],
    ),
    db.query<{ badge_key: string; owners: string }>(
      `SELECT badge_key, count(DISTINCT bitrix_id)::text AS owners FROM badge_awards GROUP BY 1`,
    ),
    db.query<{ n: string }>(`SELECT count(DISTINCT bitrix_id)::text AS n FROM badge_awards`),
    // Цена — граница между НАГРАДОЙ и АЧИВКОЙ (задача 63, п.5, решение
    // владельца 07.08). Она уже есть в данных, изобретать признак не нужно:
    // есть строка в badge_prices с ценой > 0 — за событие платят MLT, это
    // награда; нет — это чистый статус, ачивка. Берём максимум по тирам:
    // у ступенчатых цена разная, а на карточке нужна одна.
    db.query<{ badge_key: string; price: string }>(
      `SELECT badge_key, max(price)::text AS price FROM badge_prices GROUP BY 1`,
    ).catch(() => ({ rows: [] as { badge_key: string; price: string }[] })),
  ]);

  const players = Math.max(1, Number(playersRes.rows[0]?.n ?? 1));
  const mine = new Map(mineRes.rows.map(r => [r.badge_key, { n: Number(r.n), last: r.last_at }]));
  const owners = new Map(ownersRes.rows.map(r => [r.badge_key, Number(r.owners)]));
  const priceOf = new Map(pricesRes.rows.map(r => [r.badge_key, Number(r.price)]));

  const items: CollectionItem[] = [];
  for (const d of defsRes.rows) {
    const crit = (d.criteria ?? {}) as Record<string, unknown>;
    if (crit.silent === true) continue; // тихие начисления — не ачивки, они в выписке
    const own = mine.get(d.key);
    const owned = !!own;
    // Секретку показываем ТОЛЬКО получившему (владелец: «даже блеклыми не отображаются»).
    if (d.is_secret && !owned) continue;
    const pct = Math.round(((owners.get(d.key) ?? 0) / players) * 1000) / 10;
    items.push({
      key: d.key, name: d.name, description: d.description, icon: d.icon,
      category: d.category, tiered: d.tiered, isSecret: d.is_secret, setOf: d.set_of ?? [],
      owned, count: own?.n ?? 0, ownersPct: pct, rarity: rarityOf(pct),
      lastAwardedAt: own?.last ?? null,
      price: priceOf.get(d.key) ?? 0,
      paid: (priceOf.get(d.key) ?? 0) > 0,
    });
  }

  // Счётчики вверху раздела: сколько собрано по каждой ступени редкости.
  const totals: Record<Rarity, { owned: number; total: number }> = {
    common: { owned: 0, total: 0 }, uncommon: { owned: 0, total: 0 }, rare: { owned: 0, total: 0 },
    epic: { owned: 0, total: 0 }, legendary: { owned: 0, total: 0 },
  };
  for (const it of items) {
    totals[it.rarity].total += 1;
    if (it.owned) totals[it.rarity].owned += 1;
  }

  return NextResponse.json({
    items,
    totals,
    ownedCount: items.filter(i => i.owned).length,
    totalCount: items.length,
    players,
  });
}
