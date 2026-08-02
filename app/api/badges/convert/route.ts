import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';
import { pushViaAnalitik } from '@/features/badges/engine/notifications';

// Конвертация валют (доп. Серёги 31.07): ТОЛЬКО рубли → MLT (было «ебаллы»,
// ребренд задачи 2747 — по курсу из настроек (badge_coin_settings.rub_to_eball_rate,
// дефолт 1:1). Обратной операции (MLT → рубли) НЕ СУЩЕСТВУЕТ ни здесь, ни
// где-либо в движке — запрет на уровне API: этот эндпоинт списывает строго RUB
// и зачисляет строго EBALL двумя связанными записями (link_id), других путей
// обмена нет.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { amount?: unknown; direction?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  // Явная защита от попытки обратной конвертации через параметр
  if (body.direction !== undefined && body.direction !== 'rub_to_eball') {
    return NextResponse.json({ error: 'Конвертация возможна только из рублей в MLT' }, { status: 400 });
  }
  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: 'Сумма — целое число больше нуля' }, { status: 400 });
  }

  const id = Number(session.bitrixUserId);
  const db = systemDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const bal = await client.query<{ balance: string }>(
      `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger WHERE bitrix_id = $1 AND currency = 'RUB'`,
      [id],
    );
    const rub = Number(bal.rows[0]?.balance ?? 0);
    if (amount > rub) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: `Недостаточно рублей: доступно ${rub}` }, { status: 400 });
    }
    const rateRes = await client.query<{ rate: string }>(
      `SELECT rub_to_eball_rate AS rate FROM badge_coin_settings WHERE id = 1`,
    );
    const rate = Number(rateRes.rows[0]?.rate ?? 1);
    const eballs = Math.round(amount * rate);
    if (eballs <= 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'По текущему курсу получится 0 — увеличьте сумму' }, { status: 400 });
    }
    const currencyName = await getCurrencyName(client);
    const out = await client.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, actor_login, comment)
       VALUES ($1, $2, $3, 'RUB', 'convert', $4, $5) RETURNING id`,
      [id, -amount, amount, session.login, `Конвертация ${amount} ₽ → ${eballs} ${currencyName} (курс ${rate})`],
    );
    await client.query(
      `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, actor_login, comment, link_id)
       VALUES ($1, $2, $2, 'EBALL', 'convert', $3, $4, $5)`,
      [id, eballs, session.login, `Конвертация ${amount} ₽ → ${eballs} ${currencyName} (курс ${rate})`, out.rows[0].id],
    );
    await client.query('COMMIT');
    // Пуш «Аналитиком» (задача 2759, п.9) — ПОСЛЕ коммита, best-effort.
    void pushViaAnalitik(id, `💱 Конвертация: ${amount} ₽ → ${eballs} ${currencyName}`, `Курс: 1 ₽ = ${rate} ${currencyName}`);
    return NextResponse.json({ ok: true, spentRub: amount, gainedEballs: eballs, rate });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
