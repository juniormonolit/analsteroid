import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb, analyticsDb } from '@/lib/db/clients';
import { recomputeFifoRemaining } from '@/features/badges/engine/wallet';

// «Релизный старт» (дополнение Серёги 31.07): МЕХАНИЗМ ЗАЛОЖЕН, НЕ ЗАПУЩЕН.
// На официальном публичном релизе геймификации: ретро-НАГРАДЫ (полки бейджей)
// остаются как есть, а EBALL-балансы выравниваются — всем одинаковый старт.
//  (1) все существующие EBALL-балансы закрываются записью-обнулением
//      source='release_zero' (−баланс каждому; должникам — +долг, тоже в ноль);
//  (2) каждому активному менеджеру (sa.org_resolved_hierarchy is_active)
//      начисляется одинаковый грант source='release_grant' (дефолт 3000, параметр);
//  (3) badge_awards (полки) и RUB-кошельки НЕ трогаются;
//  (4) одноразово: release_started_at IS NULL обязателен, повторный запуск 400.
// Кнопка в «Настройки → Награды» за двойным подтверждением (текст «РЕЛИЗ»).

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const r = await systemDb().query<{ started_at: string | null }>(
    `SELECT to_char(release_started_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS started_at
       FROM badge_coin_settings WHERE id = 1`,
  );
  return NextResponse.json({ startedAt: r.rows[0]?.started_at ?? null });
}

export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  let body: { amount?: unknown; confirm?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  if (body.confirm !== 'РЕЛИЗ') {
    return NextResponse.json({ error: 'Для запуска передайте confirm="РЕЛИЗ" — операция необратима' }, { status: 400 });
  }
  const amount = body.amount === undefined ? 3000 : body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > 1_000_000) {
    return NextResponse.json({ error: 'Сумма гранта — целое число больше нуля' }, { status: 400 });
  }

  // Ростер активных менеджеров — из аналитической БД, до транзакции.
  const roster = await analyticsDb().query<{ id: number }>(
    `SELECT DISTINCT manager_bitrix_user_id::int AS id
       FROM sa.org_resolved_hierarchy WHERE is_active = true AND manager_bitrix_user_id IS NOT NULL`,
  );
  const managerIds = roster.rows.map(r => r.id);
  if (managerIds.length === 0) return NextResponse.json({ error: 'Ростер активных менеджеров пуст' }, { status: 500 });

  const db = systemDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Одноразовость: замок строки настроек + проверка флага.
    const s = await client.query<{ release_started_at: string | null }>(
      `SELECT release_started_at FROM badge_coin_settings WHERE id = 1 FOR UPDATE`,
    );
    if (s.rows[0]?.release_started_at) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Релизный старт уже выполнен — повторный запуск запрещён' }, { status: 400 });
    }
    // (1) Обнуление всех ненулевых EBALL-балансов компенсирующими записями.
    const zero = await client.query(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, actor_login, comment)
       SELECT bitrix_id, -balance, abs(balance), 'EBALL', 'release_zero', $1,
              'Релизный старт: обнуление ретро-баланса перед единым стартовым начислением'
         FROM badge_coin_balances WHERE balance <> 0`,
      [session!.login],
    );
    // (2) Единый стартовый грант активным менеджерам.
    const grant = await client.query(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, actor_login, comment)
       SELECT unnest($1::int[]), $2, $2, 'EBALL', 'release_grant', $3,
              'Релизный старт: единое стартовое начисление'`,
      [managerIds, amount, session!.login],
    );
    await client.query(`UPDATE badge_coin_settings SET release_started_at = now(), updated_at = now() WHERE id = 1`);
    // FIFO-остатки: старые лоты закрыты обнулением, гранты — новые лоты.
    await recomputeFifoRemaining(client);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, zeroed: zero.rowCount ?? 0, granted: grant.rowCount ?? 0, amount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
