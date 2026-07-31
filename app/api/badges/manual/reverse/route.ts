import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Сторно ошибочной РУЧНОЙ операции (доп. Серёги 31.07): НЕ удаление, а
// компенсирующая запись с reversal_of — история сохраняется, в выписке видно
// «отмена операции от <даты>». Только админ. Авто-начисления движка наград
// сторнировать нельзя (их правит пересчёт/выключение награды).
export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  let body: { ledgerId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const id = body.ledgerId;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    return NextResponse.json({ error: 'ledgerId обязателен' }, { status: 400 });
  }

  const db = systemDb();
  const orig = await db.query<{
    id: number; bitrix_id: number; amount: number; source: string;
    reversal_of: number | null; date: string;
  }>(
    `SELECT id, bitrix_id, amount, source, reversal_of,
            to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS date
       FROM badge_coin_ledger WHERE id = $1`,
    [id],
  );
  if (orig.rowCount === 0) return NextResponse.json({ error: 'Операция не найдена' }, { status: 404 });
  const o = orig.rows[0];
  if (o.source === 'auto') return NextResponse.json({ error: 'Авто-начисления сторнировать нельзя' }, { status: 400 });
  if (o.reversal_of !== null) return NextResponse.json({ error: 'Это уже сторно-запись' }, { status: 400 });
  const already = await db.query(`SELECT 1 FROM badge_coin_ledger WHERE reversal_of = $1`, [id]);
  if ((already.rowCount ?? 0) > 0) return NextResponse.json({ error: 'Операция уже отменена' }, { status: 400 });

  const r = await db.query<{ id: number }>(
    `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award,
                                    source, actor_bitrix_id, actor_login, comment, reversal_of)
     VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      o.bitrix_id, -o.amount, Math.abs(o.amount), o.source,
      session!.bitrixUserId ? Number(session!.bitrixUserId) : null, session!.login,
      `Отмена операции от ${o.date.split('-').reverse().join('.')}`, id,
    ],
  );
  return NextResponse.json({ ok: true, id: r.rows[0].id });
}
