import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';
import {
  getGachaPool, getGachaSettings, getPityCount, getSpinCounts, runSpin,
  HARD_PITY_AT, SOFT_PITY_FROM,
} from '@/features/badges/engine/gacha';
import { actorFromSession, spendPinRequirement, verifyPin } from '@/lib/auth/pin';

// Гача (фаза 2, 31.07). GET — витрина: пул с ОПУБЛИКОВАННЫМИ шансами, лимиты,
// pity-счётчик, история своих круток. POST — крутка: результат определяется
// на сервере (RNG в транзакции), тело запроса НЕ влияет на исход.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = systemDb();
  const id = session.bitrixUserId ? Number(session.bitrixUserId) : null;

  const [pool, settings, currencyName] = await Promise.all([
    getGachaPool(db), getGachaSettings(db), getCurrencyName(db),
  ]);
  const [pity, counts, history, bal] = id !== null
    ? await Promise.all([
        getPityCount(db, id),
        getSpinCounts(db, id),
        db.query(
          `SELECT id::int AS id, tier_key, rarity, prize_name, eball_amount, forced_by_pity,
                  to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS at
             FROM gacha_spins WHERE bitrix_id = $1 ORDER BY id DESC LIMIT 10`,
          [id],
        ),
        db.query<{ balance: string }>(
          `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger WHERE bitrix_id = $1 AND currency = 'EBALL'`,
          [id],
        ),
      ])
    : [0, { today: 0, week: 0 }, { rows: [] }, { rows: [] as { balance: string }[] }];

  return NextResponse.json({
    enabled: settings.enabled,
    spinCost: settings.spinCost,
    currencyName,
    balance: Number(bal.rows[0]?.balance ?? 0),
    limits: {
      daily: settings.dailyLimit, weekly: settings.weeklyLimit,
      dayLeft: Math.max(0, settings.dailyLimit - counts.today),
      weekLeft: Math.max(0, settings.weeklyLimit - counts.week),
    },
    pity: { counter: pity, softFrom: SOFT_PITY_FROM, hardAt: HARD_PITY_AT, toGuarantee: Math.max(0, HARD_PITY_AT - pity) },
    // Шансы публикуются: базовые ppm каждого включённого тира (сумма 1 000 000).
    pool: pool.filter(t => t.enabled).map(t => ({
      tierKey: t.tier_key, name: t.name, icon: t.icon, rarity: t.rarity,
      prizeType: t.prize_type, eballAmount: t.eball_amount,
      chancePpm: t.chance_ppm,
      soldOut: t.prize_type === 'item' && t.item_stock !== null && t.item_stock <= 0,
    })),
    history: history.rows,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { pin?: unknown } = {};
  try { body = await req.json(); } catch { /* тело необязательно, кроме пина */ }

  const db = systemDb();
  const id = Number(session.bitrixUserId);
  const settings = await getGachaSettings(db);
  const need = await spendPinRequirement(db, id, settings.spinCost);
  let pinEventId: number | null = null;
  if (need.required) {
    const actor = actorFromSession(session, req);
    const verified = await verifyPin(db, actor, body.pin, {
      operation: 'gacha_spin', amount: settings.spinCost, currency: 'EBALL',
    });
    if (!verified.ok) return NextResponse.json({ error: verified.error, pinRequired: true, reason: need.reason }, { status: verified.status });
    pinEventId = verified.pinEventId;
  }

  const result = await runSpin(db, id, pinEventId);
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, result });
}
