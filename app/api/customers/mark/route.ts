import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { systemDb } from '@/lib/db/clients';
import { fetchManagerCustomers, type NoCallReason } from '@/features/customers/engine/customers';

// Отметки клиентов «Моих заказчиков» (продолжение Серёги 01.08, миграция 123):
//   snooze  — «Отложить» до даты (месяц/квартал/полгода/дата из UI);
//   no_call — «Больше не звонить», причина ОБЯЗАТЕЛЬНА («прочее» — с комментарием);
//   wake    — «Вернуть в работу» из авто-«Спящих»;
//   clear   — снять отметку (вернуть в работу снузнутого/отказанного).
// Права — тот же рубеж, что на списке: менеджер — свои клиенты, РОП — клиентов
// подчинённых, руководство — всех (canViewManager). Клиент должен принадлежать
// списку менеджера (проверка по кэшу движка) — чужие client_key не размечаются.

const REASONS: NoCallReason[] = ['nothing_needed', 'competitor', 'negative', 'other'];

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: {
    clientKey?: string; managerId?: string; action?: string;
    until?: string; reason?: string; comment?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 }); }

  const clientKey = typeof body.clientKey === 'string' && /^[ck]\d+$/.test(body.clientKey) ? body.clientKey : null;
  const managerId = typeof body.managerId === 'string' && /^\d+$/.test(body.managerId) ? body.managerId : session.bitrixUserId;
  const action = body.action;
  if (!clientKey || !managerId || !['snooze', 'no_call', 'wake', 'clear'].includes(action ?? '')) {
    return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  }
  if (managerId !== session.bitrixUserId && !(await canViewManager(session, managerId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Клиент действительно из списка этого менеджера (кэш движка, 10 мин).
  const rows = await fetchManagerCustomers(Number(managerId));
  if (!rows.some(r => r.clientKey === clientKey)) {
    return NextResponse.json({ error: 'Клиент не найден в списке менеджера' }, { status: 404 });
  }

  const db = systemDb();
  if (action === 'clear') {
    await db.query(`DELETE FROM customer_marks WHERE client_key = $1`, [clientKey]);
    return NextResponse.json({ ok: true });
  }

  let until: string | null = null;
  let reason: NoCallReason | null = null;
  let comment: string | null = null;
  if (action === 'snooze') {
    until = typeof body.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.until) ? body.until : null;
    const todayMsk = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    if (!until || until <= todayMsk) {
      return NextResponse.json({ error: 'Укажите дату в будущем' }, { status: 400 });
    }
  }
  if (action === 'no_call') {
    reason = REASONS.find(x => x === body.reason) ?? null;
    if (!reason) return NextResponse.json({ error: 'Причина обязательна' }, { status: 400 });
    comment = typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim().slice(0, 500) : null;
    if (reason === 'other' && !comment) {
      return NextResponse.json({ error: 'Для «Прочее» нужен комментарий' }, { status: 400 });
    }
  }

  await db.query(
    `INSERT INTO customer_marks (client_key, kind, snooze_until, reason, comment, created_by, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (client_key) DO UPDATE SET
       kind = EXCLUDED.kind, snooze_until = EXCLUDED.snooze_until,
       reason = EXCLUDED.reason, comment = EXCLUDED.comment,
       created_by = EXCLUDED.created_by, created_by_user_id = EXCLUDED.created_by_user_id,
       created_at = now()`,
    [clientKey, action, until, reason, comment, session.displayName, session.id],
  );
  return NextResponse.json({ ok: true });
}
