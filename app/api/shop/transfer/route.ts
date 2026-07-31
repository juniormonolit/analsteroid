import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb, analyticsDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';
import { recomputeFifoRemaining } from '@/features/badges/engine/wallet';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';

// Переводы ебаллов между менеджерами (пакет Серёги 31.07): отправитель платит X,
// получатель получает X − комиссия (transfer_fee_percent, дефолт 5%) — комиссия
// сжигается отдельной записью 'transfer_fee'. Дневной лимит по СУММЕ исходящих
// (transfer_daily_limit, дефолт 500). Списания FIFO. Обе выписки показывают
// от кого/кому и комиссию; получателю — уведомление + пуш «Аналитиком».

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = systemDb();
  const id = session.bitrixUserId ? Number(session.bitrixUserId) : null;

  const [settings, currencyName, roster] = await Promise.all([
    db.query<{ fee: string; lim: number }>(
      `SELECT transfer_fee_percent AS fee, transfer_daily_limit AS lim FROM badge_coin_settings WHERE id = 1`,
    ),
    getCurrencyName(db),
    analyticsDb().query<{ id: number; name: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::int AS id, manager_name AS name
         FROM sa.org_resolved_hierarchy WHERE is_active = true AND manager_bitrix_user_id IS NOT NULL
        ORDER BY manager_name`,
    ),
  ]);
  const sent = id !== null
    ? await db.query<{ s: string }>(
        `SELECT coalesce(sum(-amount), 0) AS s FROM badge_coin_ledger
          WHERE bitrix_id = $1 AND source IN ('transfer_out','transfer_fee')
            AND created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'`,
        [id],
      )
    : { rows: [{ s: '0' }] };

  return NextResponse.json({
    currencyName,
    feePercent: Number(settings.rows[0]?.fee ?? 5),
    dailyLimit: settings.rows[0]?.lim ?? 500,
    sentToday: Number(sent.rows[0]?.s ?? 0),
    managers: roster.rows.filter(m => id === null || m.id !== id),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { toBitrixId?: unknown; amount?: unknown; comment?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const to = body.toBitrixId;
  const amount = body.amount;
  if (typeof to !== 'number' || !Number.isInteger(to) || to <= 0) return NextResponse.json({ error: 'toBitrixId обязателен' }, { status: 400 });
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: 'Сумма — целое число больше нуля' }, { status: 400 });
  }
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 300) : '';

  const from = Number(session.bitrixUserId);
  if (to === from) return NextResponse.json({ error: 'Себе переводить нельзя' }, { status: 400 });

  // Получатель — только активный менеджер из оргструктуры (истина — аналитика).
  const rcpt = await analyticsDb().query<{ name: string }>(
    `SELECT manager_name AS name FROM sa.org_resolved_hierarchy
      WHERE is_active = true AND manager_bitrix_user_id = $1 LIMIT 1`,
    [String(to)],
  );
  if (rcpt.rowCount === 0) return NextResponse.json({ error: 'Получатель не найден среди активных менеджеров' }, { status: 400 });
  const toName = rcpt.rows[0].name;
  const fromName = session.displayName || session.login;

  const db = systemDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('transfer_' || $1::text))`, [from]);

    const s = await client.query<{ fee: string; lim: number }>(
      `SELECT transfer_fee_percent AS fee, transfer_daily_limit AS lim FROM badge_coin_settings WHERE id = 1`,
    );
    const feePercent = Number(s.rows[0]?.fee ?? 5);
    const dailyLimit = s.rows[0]?.lim ?? 500;
    const fee = Math.floor(amount * feePercent / 100);
    const received = amount - fee;
    if (received <= 0) { await client.query('ROLLBACK'); return NextResponse.json({ error: 'После комиссии получателю ничего не дойдёт — увеличьте сумму' }, { status: 400 }); }

    const sent = await client.query<{ s: string }>(
      `SELECT coalesce(sum(-amount), 0) AS s FROM badge_coin_ledger
        WHERE bitrix_id = $1 AND source IN ('transfer_out','transfer_fee')
          AND created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'`,
      [from],
    );
    const sentToday = Number(sent.rows[0]?.s ?? 0);
    if (sentToday + amount > dailyLimit) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: `Дневной лимит переводов ${dailyLimit}: сегодня уже отправлено ${sentToday}, доступно ${Math.max(0, dailyLimit - sentToday)}` }, { status: 400 });
    }

    const bal = await client.query<{ balance: string }>(
      `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger WHERE bitrix_id = $1 AND currency = 'EBALL'`,
      [from],
    );
    const balance = Number(bal.rows[0]?.balance ?? 0);
    if (amount > balance) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: `Не хватает средств: перевод ${amount}, на балансе ${balance}` }, { status: 400 });
    }

    const note = comment ? ` — «${comment}»` : '';
    const out = await client.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, actor_login, comment)
       VALUES ($1, $2, $3, 'EBALL', 'transfer_out', $4, $5) RETURNING id`,
      [from, -received, received, session.login, `Перевод для ${toName}${note}`],
    );
    if (fee > 0) {
      await client.query(
        `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, actor_login, comment, link_id)
         VALUES ($1, $2, $3, 'EBALL', 'transfer_fee', $4, $5, $6)`,
        [from, -fee, fee, session.login, `Комиссия за перевод (${feePercent}%) — сжигается`, out.rows[0].id],
      );
    }
    await client.query(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, actor_login, comment, link_id)
       VALUES ($1, $2, $2, 'EBALL', 'transfer_in', $3, $4, $5)`,
      [to, received, session.login, `Перевод от ${fromName}${note}`, out.rows[0].id],
    );
    await recomputeFifoRemaining(client, from);
    await recomputeFifoRemaining(client, to);
    await createNotification(client, {
      bitrixId: to, type: 'transfer_in',
      title: `Вам перевели ${received} ${await getCurrencyName(client)}`,
      body: `От: ${fromName}${note}`,
      link: '/manager/me',
    });
    await client.query('COMMIT');
    void pushViaAnalitik(to, `Вам перевели ${received} ебаллов`, `От: ${fromName}${note}`);
    return NextResponse.json({ ok: true, sent: amount, received, fee });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
