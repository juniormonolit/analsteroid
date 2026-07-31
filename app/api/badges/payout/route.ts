import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { systemDb, analyticsDb } from '@/lib/db/clients';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';

// Вывод рублей в ЗП (доп. Серёги 31.07): менеджер подаёт заявку (сумма не
// больше рублёвого баланса), РОП своих / админ отмечает «выплачено» (списание
// с баланса записью source='payout') или отклоняет с комментарием. Фактическая
// выплата — бухгалтерией вне системы, здесь фиксация.

async function manageScope(session: SessionUser): Promise<'all' | Set<string> | null> {
  if (hasFullManagerAccess(session)) return 'all';
  const deptIds = await managedDepartmentIds(session);
  if (deptIds.length === 0) return null;
  const roster = await resolveManagersForDepartments(deptIds);
  return new Set(roster.map(m => m.managerId));
}

// GET: свои заявки; ?scope=manage — заявки подчинённых (РОП) / всех (админ).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = systemDb();

  if (req.nextUrl.searchParams.get('scope') === 'manage') {
    const scope = await manageScope(session);
    if (scope === null) return NextResponse.json({ requests: [], canManage: false });
    const where = scope === 'all' ? '' : `WHERE p.bitrix_id = ANY($1::int[])`;
    const params = scope === 'all' ? [] : [[...scope].map(Number)];
    const res = await db.query(
      `SELECT p.id::int AS id, p.bitrix_id, p.amount, p.status, p.comment, p.resolver_login,
              to_char(p.requested_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS requested_at,
              to_char(p.resolved_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS resolved_at,
              coalesce(b.balance, 0)::int AS rub_balance
         FROM payout_requests p
         LEFT JOIN badge_rub_balances b ON b.bitrix_id = p.bitrix_id
         ${where}
        ORDER BY (p.status = 'requested') DESC, p.requested_at DESC
        LIMIT 200`,
      params,
    );
    // Имена менеджеров — из sa.employees (для списка РОПа/админа).
    const ids = [...new Set(res.rows.map(r => Number(r.bitrix_id)))];
    const names = ids.length > 0
      ? await analyticsDb().query<{ bitrix_id: number; full_name: string }>(
          `SELECT bitrix_id, full_name FROM sa.employees WHERE bitrix_id = ANY($1::int[])`, [ids],
        )
      : { rows: [] as { bitrix_id: number; full_name: string }[] };
    const nameBy = new Map(names.rows.map(n => [Number(n.bitrix_id), n.full_name]));
    return NextResponse.json({
      canManage: true,
      requests: res.rows.map(r => ({ ...r, managerName: nameBy.get(Number(r.bitrix_id)) ?? String(r.bitrix_id) })),
    });
  }

  if (!session.bitrixUserId) return NextResponse.json({ requests: [] });
  const res = await db.query(
    `SELECT id::int AS id, amount, status, comment, resolver_login,
            to_char(requested_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS requested_at,
            to_char(resolved_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS resolved_at
       FROM payout_requests WHERE bitrix_id = $1
      ORDER BY requested_at DESC LIMIT 50`,
    [Number(session.bitrixUserId)],
  );
  return NextResponse.json({ requests: res.rows });
}

// POST: менеджер подаёт заявку на вывод своих рублей.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { amount?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: 'Сумма — целое число больше нуля' }, { status: 400 });
  }

  const id = Number(session.bitrixUserId);
  const db = systemDb();
  const bal = await db.query<{ balance: string }>(
    `SELECT coalesce(sum(amount), 0) AS balance FROM badge_coin_ledger WHERE bitrix_id = $1 AND currency = 'RUB'`,
    [id],
  );
  const rub = Number(bal.rows[0]?.balance ?? 0);
  // Сумма заявки ограничена балансом С УЧЁТОМ уже поданных (requested) заявок —
  // иначе двумя заявками можно запросить больше, чем есть.
  const pending = await db.query<{ s: string }>(
    `SELECT coalesce(sum(amount), 0) AS s FROM payout_requests WHERE bitrix_id = $1 AND status = 'requested'`,
    [id],
  );
  const available = rub - Number(pending.rows[0]?.s ?? 0);
  if (amount > available) {
    return NextResponse.json({ error: `Доступно к выводу ${Math.max(0, available)} ₽ (с учётом уже поданных заявок)` }, { status: 400 });
  }
  const r = await db.query<{ id: number }>(
    `INSERT INTO payout_requests (bitrix_id, amount) VALUES ($1, $2) RETURNING id`,
    [id, amount],
  );
  return NextResponse.json({ ok: true, id: r.rows[0].id });
}

// PATCH: {id, action:'paid'|'rejected', comment?} — РОП своих / админ.
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { id?: unknown; action?: unknown; comment?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const id = body.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return NextResponse.json({ error: 'id обязателен' }, { status: 400 });
  if (body.action !== 'paid' && body.action !== 'rejected') {
    return NextResponse.json({ error: 'action: paid | rejected' }, { status: 400 });
  }
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
  if (body.action === 'rejected' && !comment) {
    return NextResponse.json({ error: 'При отклонении комментарий обязателен — менеджер увидит причину' }, { status: 400 });
  }

  const db = systemDb();
  const reqRow = await db.query<{ bitrix_id: number; amount: number; status: string }>(
    `SELECT bitrix_id, amount, status FROM payout_requests WHERE id = $1`, [id],
  );
  if (reqRow.rowCount === 0) return NextResponse.json({ error: 'Заявка не найдена' }, { status: 404 });
  const p = reqRow.rows[0];
  if (p.status !== 'requested') return NextResponse.json({ error: 'Заявка уже обработана' }, { status: 400 });

  const scope = await manageScope(session);
  if (scope === null || (scope !== 'all' && !scope.has(String(p.bitrix_id)))) {
    return NextResponse.json({ error: 'Заявки этого сотрудника вам недоступны' }, { status: 403 });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE payout_requests SET status = $2, resolved_at = now(), resolver_login = $3, comment = nullif($4, '')
        WHERE id = $1`,
      [id, body.action, session.login, comment],
    );
    if (body.action === 'paid') {
      // Списание рублей с баланса — фиксация выплаты в ЗП.
      await client.query(
        `INSERT INTO badge_coin_ledger (bitrix_id, amount, price_at_award, currency, source, actor_login, comment, payout_request_id)
         VALUES ($1, $2, $3, 'RUB', 'payout', $4, $5, $6)`,
        [p.bitrix_id, -p.amount, p.amount, session.login, `Вывод в ЗП (заявка #${id})`, id],
      );
    }
    // Уведомление менеджеру (в той же транзакции) + пуш после коммита.
    const paid = body.action === 'paid';
    await createNotification(client, {
      bitrixId: Number(p.bitrix_id), type: 'payout_resolved',
      title: paid ? `Выплата ${p.amount} ₽ подтверждена` : `Заявка на вывод ${p.amount} ₽ отклонена`,
      body: paid ? `Подтвердил: ${session.login}. Сумма списана с рублёвого кошелька.` : `Причина: ${comment}`,
      link: '/manager/me',
    });
    await client.query('COMMIT');
    void pushViaAnalitik(Number(p.bitrix_id),
      paid ? `Выплата ${p.amount} ₽ подтверждена` : `Заявка на вывод ${p.amount} ₽ отклонена`,
      paid ? `Подтвердил: ${session.login}` : `Причина: ${comment}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true });
}
