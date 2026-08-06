// Косметика профиля: рамки аватара и эмодзи-фоны за MLT (задача #34).
//
//   GET  — каталог с признаками «куплено» и «надето» + баланс;
//   POST {action:'buy', id}    — покупка;
//   POST {action:'equip', ...} — надеть/снять (frameId / backgroundId, null = снять).
//
// Деньги идут в ЕДИНЫЙ леджер (badge_coin_ledger, source='cosmetic_purchase'),
// а не мимо: дашборд экономики обязан видеть эти траты вместе с магазинными.
// Порог пина тоже общий (spendPinRequirement) — второго правила «когда спрашивать
// пин» в проекте быть не должно.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { actorFromSession, spendPinRequirement, verifyPin } from '@/lib/auth/pin';
import { recomputeFifoRemaining } from '@/features/badges/engine/wallet';
import {
  COSMETICS,
  cosmeticById,
  isFree,
  DEFAULT_BACKGROUND_ID,
  DEFAULT_FRAME_ID,
} from '@/lib/profile/cosmetics';

/** true — таблиц ещё нет (миграция 157 не накатана). */
function isMissingTable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P01';
}

interface Equipped {
  frameId: string;
  backgroundId: string;
}

async function loadState(bitrixId: number): Promise<{ owned: Set<string>; equipped: Equipped; storageReady: boolean }> {
  const fallback = {
    owned: new Set<string>(),
    equipped: { frameId: DEFAULT_FRAME_ID, backgroundId: DEFAULT_BACKGROUND_ID },
    storageReady: false,
  };
  try {
    const [ownedRes, eq] = await Promise.all([
      systemDb().query<{ cosmetic_id: string }>(
        `SELECT cosmetic_id FROM profile_cosmetics_owned WHERE bitrix_id = $1`, [bitrixId]),
      systemDb().query<{ frame_id: string | null; background_id: string | null }>(
        `SELECT frame_id, background_id FROM profile_cosmetics WHERE bitrix_id = $1`, [bitrixId]),
    ]);
    return {
      owned: new Set(ownedRes.rows.map(r => r.cosmetic_id)),
      equipped: {
        frameId: eq.rows[0]?.frame_id ?? DEFAULT_FRAME_ID,
        backgroundId: eq.rows[0]?.background_id ?? DEFAULT_BACKGROUND_ID,
      },
      storageReady: true,
    };
  } catch (err) {
    // До миграции раздел показывает каталог и бесплатные позиции, а не 500.
    if (isMissingTable(err)) return fallback;
    throw err;
  }
}

async function balanceOf(bitrixId: number): Promise<number> {
  const res = await systemDb().query<{ balance: string }>(
    `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger WHERE bitrix_id = $1 AND currency = 'EBALL'`,
    [bitrixId],
  );
  return Number(res.rows[0]?.balance ?? 0);
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 409 });
  const bitrixId = Number(session.bitrixUserId);

  const [state, balance] = await Promise.all([loadState(bitrixId), balanceOf(bitrixId)]);

  return NextResponse.json({
    balance,
    storageReady: state.storageReady,
    equipped: state.equipped,
    cosmetics: COSMETICS.map(c => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      price: c.price,
      ring: c.ring ?? null,
      emoji: c.emoji ?? null,
      backdrop: c.backdrop ?? null,
      owned: isFree(c) || state.owned.has(c.id),
    })),
  });
}

async function buy(bitrixId: number, cosmeticId: string, req: NextRequest, pin: unknown) {
  const def = cosmeticById(cosmeticId);
  if (!def) return NextResponse.json({ error: 'Неизвестная позиция' }, { status: 404 });
  if (isFree(def)) return NextResponse.json({ error: 'Эта позиция и так доступна' }, { status: 400 });

  const db = systemDb();
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Пин — по общему порогу трат, до открытия денежной транзакции (verifyPin
  // пишет свою). Цена косметики фиксирована в коде, поэтому гонки «цена
  // изменилась между пре-чеком и списанием», как в магазине, здесь нет.
  const need = await spendPinRequirement(db, bitrixId, def.price);
  let pinEventId: number | null = null;
  if (need.required) {
    const verified = await verifyPin(db, actorFromSession(session, req), pin, {
      operation: 'cosmetic_purchase', targetRef: cosmeticId, amount: def.price, currency: 'EBALL',
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error, pinRequired: true, reason: need.reason }, { status: verified.status });
    }
    pinEventId = verified.pinEventId;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Блокируем строку владения: два параллельных клика не должны списать дважды.
    const already = await client.query(
      `SELECT 1 FROM profile_cosmetics_owned WHERE bitrix_id = $1 AND cosmetic_id = $2 FOR UPDATE`,
      [bitrixId, cosmeticId],
    );
    if (already.rowCount) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Уже куплено' }, { status: 409 });
    }

    const bal = await client.query<{ balance: string }>(
      `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger
        WHERE bitrix_id = $1 AND currency = 'EBALL'`,
      [bitrixId],
    );
    const balance = Number(bal.rows[0]?.balance ?? 0);
    if (def.price > balance) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: `Не хватает средств: цена ${def.price}, на балансе ${balance}` }, { status: 400 });
    }

    const led = await client.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, comment, pin_event_id)
       VALUES ($1, $2, $3, 'EBALL', 'cosmetic_purchase', $4, $5) RETURNING id`,
      [bitrixId, -def.price, def.price, `Оформление профиля: ${def.name}`, pinEventId],
    );
    await client.query(
      `INSERT INTO profile_cosmetics_owned (bitrix_id, cosmetic_id, price_paid, ledger_id)
       VALUES ($1, $2, $3, $4)`,
      [bitrixId, cosmeticId, def.price, led.rows[0].id],
    );
    // FIFO по TTL баллов — та же процедура, что после покупки в магазине.
    await recomputeFifoRemaining(client, bitrixId);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, balance: balance - def.price });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (isMissingTable(err)) {
      return NextResponse.json({ error: 'Оформление профиля ещё не готово (миграция 157 не применена)' }, { status: 503 });
    }
    throw err;
  } finally {
    client.release();
  }
}

async function equip(bitrixId: number, body: Record<string, unknown>) {
  const state = await loadState(bitrixId);
  if (!state.storageReady) {
    return NextResponse.json({ error: 'Оформление профиля ещё не готово (миграция 157 не применена)' }, { status: 503 });
  }

  const pick = (raw: unknown, kind: 'frame' | 'background', fallback: string): string | null | 'invalid' => {
    if (raw === undefined) return null;               // поле не прислали — не трогаем
    if (raw === null) return fallback;                // явный null — снять
    if (typeof raw !== 'string') return 'invalid';
    const def = cosmeticById(raw);
    if (!def || def.kind !== kind) return 'invalid';
    // Надеть можно только своё: гейт здесь, замочек в пикере — лишь отображение.
    if (!isFree(def) && !state.owned.has(def.id)) return 'invalid';
    return def.id;
  };

  const frame = pick(body.frameId, 'frame', DEFAULT_FRAME_ID);
  const background = pick(body.backgroundId, 'background', DEFAULT_BACKGROUND_ID);
  if (frame === 'invalid' || background === 'invalid') {
    return NextResponse.json({ error: 'Позиция недоступна' }, { status: 403 });
  }

  const next = {
    frameId: frame ?? state.equipped.frameId,
    backgroundId: background ?? state.equipped.backgroundId,
  };
  await systemDb().query(
    `INSERT INTO profile_cosmetics (bitrix_id, frame_id, background_id)
          VALUES ($1, $2, $3)
     ON CONFLICT (bitrix_id)
       DO UPDATE SET frame_id = EXCLUDED.frame_id, background_id = EXCLUDED.background_id, updated_at = now()`,
    [bitrixId, next.frameId, next.backgroundId],
  );
  return NextResponse.json({ ok: true, equipped: next });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 409 });
  const bitrixId = Number(session.bitrixUserId);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  if (body.action === 'buy') {
    if (typeof body.id !== 'string') return NextResponse.json({ error: 'id обязателен' }, { status: 400 });
    return buy(bitrixId, body.id, req, body.pin);
  }
  if (body.action === 'equip') return equip(bitrixId, body);
  return NextResponse.json({ error: 'action: buy | equip' }, { status: 400 });
}
