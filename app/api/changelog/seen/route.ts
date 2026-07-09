import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// «Отметить всё прочитанным» (клик по пункту меню открывает панель — п.4 задачи —
// или клик по ссылке в шапке панели): переносит changelog_seen_at на текущий момент,
// счётчик непрочитанных в GET /api/changelog обнуляется.
//
// GREATEST(now(), max(published_at)) вместо голого now() — защита от бага
// 09.07 (seed-записи миграции 056 с published_at ВПЕРЕДИ реального времени сервера
// держали «непрочитано» навсегда, т.к. now() на момент отметки был МЕНЬШЕ их
// published_at). Если у какой-то существующей записи дата всё же оказалась
// впереди сервера — «прочитано» гарантированно её накрывает. Будущие деплой-записи
// (INSERT published_at=now() ПОСЛЕ этой отметки) всё равно попадут позже
// changelog_seen_at и корректно останутся «новыми» — именно поэтому важно, чтобы
// сид-даты сами по себе не были в будущем (см. миграцию 056).
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const res = await systemDb().query<{ changelog_seen_at: Date }>(
    `UPDATE users
        SET changelog_seen_at = GREATEST(
          now(),
          (SELECT COALESCE(max(published_at), now()) FROM changelog_entries)
        )
      WHERE id = $1
      RETURNING changelog_seen_at`,
    [session.id]
  );
  return NextResponse.json({ ok: true, seenAt: res.rows[0]?.changelog_seen_at?.toISOString() ?? null });
}
