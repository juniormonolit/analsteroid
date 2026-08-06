import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { systemDb } from '@/lib/db/clients';
import { approversFor } from '@/lib/org/approvers';
import { createNotification, notifyAndPush, pushViaAnalitik } from '@/features/badges/engine/notifications';
import { resolveEmployeeNames } from '@/lib/org/employeeDirectory';
import { actorFromSession, verifyPin } from '@/lib/auth/pin';

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
  // Задача 2820: было sa.employees (мёртвая заготовка) — единая функция
  // lib/org/employeeDirectory.ts (sa.org_resolved_hierarchy).
  const ids = [...new Set(res.rows.map(r => Number(r.bitrix_id)))];
  const nameBy = await resolveEmployeeNames(ids);
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

  // Уведомить того, кто заявку решает. Раньше НИКТО не уведомлялся: менеджер
  // подавал заявку, и она лежала, пока руководитель случайно не зайдёт в раздел.
  // Уведомление о РЕШЕНИИ заявителю было (см. PATCH ниже), а о ПОЯВЛЕНИИ —
  // никому.
  //
  // Кнопок «Одобрить»/«Отклонить» в сообщении бота сознательно НЕТ, хотя
  // просили именно их:
  //   * одобрение ВСЕГДА требует пин-код (см. PATCH — это расход ценности), а
  //     клик по кнопке чата пин передать не может; предлагать вводить пин
  //     сообщением в чат Битрикса — значит гонять секрет в открытом виде через
  //     переписку, чего проект не делает нигде;
  //   * отклонение требует обязательной причины, которую увидит менеджер, —
  //     кнопка её тоже не несёт.
  // Поэтому решение остаётся в приложении, где для пина и причины есть поля, а
  // уведомление закрывает настоящую дыру: раньше о заявке не узнавал НИКТО.
  // Ссылка на раздел лежит в самом уведомлении — клик по колокольчику ведёт
  // прямо на /profile/requests.
  void notifyApprovers(Number(session.bitrixUserId), session.displayName, body.inventoryId, comment);

  return NextResponse.json({ ok: true });
}

async function notifyApprovers(
  requesterId: number,
  requesterName: string,
  inventoryId: number,
  comment: string,
): Promise<void> {
  try {
    const [approvers, item] = await Promise.all([
      approversFor(requesterId),
      systemDb().query<{ item_name: string }>(`SELECT item_name FROM inventory_items WHERE id = $1`, [inventoryId]),
    ]);
    if (approvers.length === 0) return; // некому решать — тишина лучше, чем спам всем
    const itemName = item.rows[0]?.item_name ?? 'предмет';

    // notifyAndPush, а не sendBitrixBotMessage напрямую: это единственный путь,
    // который уважает dry-run, персональные настройки бота и пишет в
    // bot_outbound_log. Ссылка на раздел живёт в самом уведомлении (клик по
    // колокольчику ведёт на /profile/requests) — отдельная кнопка в чате не
    // нужна, а обход общего пути стоил бы потери всего перечисленного.
    for (const approverId of approvers) {
      void notifyAndPush(systemDb(), {
        bitrixId: Number(approverId),
        type: 'activation_requested',
        title: `Заявка на активацию: ${itemName}`,
        body: `${requesterName}${comment ? ` · ${comment}` : ''}`,
        link: '/profile/requests',
      });
    }
  } catch (e) {
    // Уведомление — не часть подачи заявки: заявка уже создана и видна в разделе.
    console.warn('[shop-activate] не удалось уведомить решающих:', e instanceof Error ? e.message : e);
  }
}

// PATCH: {id, action:'approve'|'reject', comment?} — РОП своих / админ.
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { id?: unknown; action?: unknown; comment?: unknown; pin?: unknown };
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

  // Одобрение — расход предмета менеджера, пин ВСЕГДА (спека §3); резолвера,
  // а не заявителя (это резолвер сейчас списывает ценность). Отклонение денег
  // не двигает — пин не нужен.
  if (body.action === 'approve') {
    const actor = actorFromSession(session, req);
    const verified = await verifyPin(db, actor, body.pin, { operation: 'shop_activate_approve', targetRef: String(id) });
    if (!verified.ok) return NextResponse.json({ error: verified.error, pinRequired: true }, { status: verified.status });
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
  await createNotification(db, { bitrixId: Number(row.rows[0].bitrix_id), type: 'activation_resolved', title, body: bodyText, link: '/profile' });
  void pushViaAnalitik(Number(row.rows[0].bitrix_id), title, bodyText);
  return NextResponse.json({ ok: true });
}
