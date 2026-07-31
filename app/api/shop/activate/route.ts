import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { systemDb, analyticsDb } from '@/lib/db/clients';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';

// Заявки на активацию предметов инвентаря (MVP магазина, 31.07) — клон механики
// payout_requests: менеджер просит активировать предмет (owned →
// activation_requested), РОП своих / админ одобряет (→ used) или отклоняет
// с обязательной причиной (→ ОБРАТНО в owned: ебаллы уже уплачены, отказ
// касается конкретной даты, а не права — дизайн-док, раздел 3.1).

async function manageScope(session: SessionUser): Promise<'all' | Set<string> | null> {
  if (hasFullManagerAccess(session)) return 'all';
  const deptIds = await managedDepartmentIds(session);
  if (deptIds.length === 0) return null;
  const roster = await resolveManagersForDepartments(deptIds);
  return new Set(roster.map(m => m.managerId));
}

// GET ?scope=manage — входящие заявки подчинённых (РОП) / всех (админ).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (req.nextUrl.searchParams.get('scope') !== 'manage') {
    return NextResponse.json({ error: 'scope=manage обязателен' }, { status: 400 });
  }
  const scope = await manageScope(session);
  if (scope === null) return NextResponse.json({ requests: [], canManage: false });

  const db = systemDb();
  const where = scope === 'all' ? '' : `AND i.bitrix_id = ANY($1::int[])`;
  const params = scope === 'all' ? [] : [[...scope].map(Number)];
  const res = await db.query(
    `SELECT i.id::int AS id, i.bitrix_id, i.item_name, i.price_paid, i.currency, i.status,
            i.activation_comment, i.resolver_login, i.resolve_comment,
            to_char(i.requested_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS requested_at,
            to_char(i.expires_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS expires_at,
            to_char(i.resolved_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS resolved_at
       FROM inventory_items i
      WHERE (i.status = 'activation_requested' OR (i.status = 'used' AND i.resolved_at > now() - interval '30 days')
             OR (i.status = 'owned' AND i.resolved_at > now() - interval '30 days' AND i.resolve_comment IS NOT NULL))
        ${where}
      ORDER BY (i.status = 'activation_requested') DESC, coalesce(i.requested_at, i.resolved_at) DESC
      LIMIT 200`,
    params,
  );
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

// POST: менеджер подаёт заявку на активацию СВОЕГО предмета {inventoryId, comment?}.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { inventoryId?: unknown; comment?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  if (typeof body.inventoryId !== 'number' || !Number.isInteger(body.inventoryId)) {
    return NextResponse.json({ error: 'inventoryId обязателен' }, { status: 400 });
  }
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';

  const r = await systemDb().query(
    `UPDATE inventory_items
        SET status = 'activation_requested', requested_at = now(),
            activation_comment = nullif($3, ''), resolve_comment = NULL
      WHERE id = $1 AND bitrix_id = $2 AND status = 'owned' AND expires_at > now()
      RETURNING id`,
    [body.inventoryId, Number(session.bitrixUserId), comment],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: 'Предмет не найден, не ваш, уже в заявке или срок истёк' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

// PATCH: {id, action:'approve'|'reject', comment?} — РОП своих / админ.
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { id?: unknown; action?: unknown; comment?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const id = body.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return NextResponse.json({ error: 'id обязателен' }, { status: 400 });
  if (body.action !== 'approve' && body.action !== 'reject') {
    return NextResponse.json({ error: 'action: approve | reject' }, { status: 400 });
  }
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
  if (body.action === 'reject' && !comment) {
    return NextResponse.json({ error: 'При отклонении комментарий обязателен — менеджер увидит причину' }, { status: 400 });
  }

  const db = systemDb();
  const row = await db.query<{ bitrix_id: number; status: string }>(
    `SELECT bitrix_id, status FROM inventory_items WHERE id = $1`, [id],
  );
  if (row.rowCount === 0) return NextResponse.json({ error: 'Заявка не найдена' }, { status: 404 });
  if (row.rows[0].status !== 'activation_requested') {
    return NextResponse.json({ error: 'Заявка уже обработана' }, { status: 400 });
  }
  const scope = await manageScope(session);
  if (scope === null || (scope !== 'all' && !scope.has(String(row.rows[0].bitrix_id)))) {
    return NextResponse.json({ error: 'Заявки этого сотрудника вам недоступны' }, { status: 403 });
  }

  // approve → used (предмет исполнен: эффект — организационно, вне системы);
  // reject → ОБРАТНО в owned с причиной, повторная активация не ограничена.
  const upd = await db.query<{ item_name: string }>(
    body.action === 'approve'
      ? `UPDATE inventory_items SET status = 'used', resolved_at = now(), resolver_login = $2, resolve_comment = nullif($3, '') WHERE id = $1 RETURNING item_name`
      : `UPDATE inventory_items SET status = 'owned', resolved_at = now(), resolver_login = $2, resolve_comment = $3, requested_at = NULL WHERE id = $1 RETURNING item_name`,
    [id, session.login, comment],
  );
  // Уведомление менеджеру + пуш «Аналитиком» (Bitrix imbot, best-effort).
  const itemName = upd.rows[0]?.item_name ?? 'предмет';
  const approved = body.action === 'approve';
  const title = approved ? `Заявка одобрена: ${itemName}` : `Заявка отклонена: ${itemName}`;
  const bodyText = approved
    ? `Одобрил: ${session.login}`
    : `Причина: ${comment}. Предмет вернулся в ваш инвентарь — можно подать заявку на другую дату.`;
  await createNotification(db, { bitrixId: Number(row.rows[0].bitrix_id), type: 'activation_resolved', title, body: bodyText, link: '/manager/me' });
  void pushViaAnalitik(Number(row.rows[0].bitrix_id), title, bodyText);
  return NextResponse.json({ ok: true });
}
