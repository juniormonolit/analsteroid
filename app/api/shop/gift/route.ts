import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb, analyticsDb } from '@/lib/db/clients';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';
import { actorFromSession, frozenMessage, isOutboundFrozen, verifyPin } from '@/lib/auth/pin';

// Подарок предмета инвентаря коллеге (пакет Серёги 31.07): только owned, не в
// заявке и не истёкший; предмет переходит получателю с СОХРАНЕНИЕМ expires_at,
// без комиссии; история переходов копится в gift_history (jsonb).

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { inventoryId?: unknown; toBitrixId?: unknown; pin?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  if (typeof body.inventoryId !== 'number' || !Number.isInteger(body.inventoryId)) {
    return NextResponse.json({ error: 'inventoryId обязателен' }, { status: 400 });
  }
  const to = body.toBitrixId;
  if (typeof to !== 'number' || !Number.isInteger(to) || to <= 0) return NextResponse.json({ error: 'toBitrixId обязателен' }, { status: 400 });

  const from = Number(session.bitrixUserId);
  if (to === from) return NextResponse.json({ error: 'Себе дарить нельзя' }, { status: 400 });

  // Подарок — ценность уходит безвозвратно: пин ВСЕГДА (спека §3) + заморозка
  // после недавнего сброса/смены пина (спека §5).
  const frozenUntil = await isOutboundFrozen(systemDb(), from);
  if (frozenUntil) return NextResponse.json({ error: frozenMessage(frozenUntil) }, { status: 423 });
  const actor = actorFromSession(session, req);
  const verified = await verifyPin(systemDb(), actor, body.pin, {
    operation: 'shop_gift', targetRef: String(body.inventoryId),
  });
  if (!verified.ok) return NextResponse.json({ error: verified.error, pinRequired: true }, { status: verified.status });

  const rcpt = await analyticsDb().query<{ name: string }>(
    `SELECT manager_name AS name FROM sa.org_resolved_hierarchy
      WHERE is_active = true AND manager_bitrix_user_id = $1 LIMIT 1`,
    [String(to)],
  );
  if (rcpt.rowCount === 0) return NextResponse.json({ error: 'Получатель не найден среди активных менеджеров' }, { status: 400 });
  const toName = rcpt.rows[0].name;
  const fromName = session.displayName || session.login;

  // Переход владельца одним UPDATE с условиями (owned/не истёк/мой) —
  // конкурентная попытка второй раз не пройдёт. expires_at НЕ трогаем.
  const r = await systemDb().query<{ id: number; item_name: string }>(
    `UPDATE inventory_items
        SET bitrix_id = $3,
            gift_history = gift_history || jsonb_build_object(
              'from', $2::int, 'fromName', $4::text, 'to', $3::int, 'toName', $5::text,
              'at', to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI')),
            requested_at = NULL, activation_comment = NULL, resolve_comment = NULL
      WHERE id = $1 AND bitrix_id = $2 AND status = 'owned' AND expires_at > now()
      RETURNING id, item_name`,
    [body.inventoryId, from, to, fromName, toName],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: 'Предмет не найден, не ваш, в заявке или срок истёк' }, { status: 400 });
  }
  await createNotification(systemDb(), {
    bitrixId: to, type: 'gift_in',
    title: `Вам подарили: ${r.rows[0].item_name}`,
    body: `От: ${fromName}. Предмет уже в вашем инвентаре (срок годности сохранён).`,
    link: '/manager/me',
  });
  void pushViaAnalitik(to, `Вам подарили: ${r.rows[0].item_name}`, `От: ${fromName}`);
  return NextResponse.json({ ok: true, itemName: r.rows[0].item_name, toName });
}
