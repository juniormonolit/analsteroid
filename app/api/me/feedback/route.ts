import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// «Мои замечания» (задача 2765, правка владельца 02.08): личный журнал
// менеджера — что он сам отправил кнопками «⚠️ Ошибка»/«👍 Полезно» под
// сообщениями «Аналитика», статус разбора и КОММЕНТАРИЙ разбирающего
// (обязателен при закрытии — см. app/api/settings/digest/feedback/route.ts).
// Строго СВОЁ — bitrixId из сессии, чужого не видно.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ rows: [] });

  const res = await systemDb().query<{
    id: string; log_id: string; signal: 'error' | 'useful'; status: string;
    reviewed_at: string | null; review_note: string | null; created_at: string;
  }>(
    `SELECT id, log_id, signal, status, reviewed_at, review_note, created_at
       FROM bot_feedback WHERE bitrix_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [Number(session.bitrixUserId)],
  ).catch(() => ({ rows: [] as never[] }));

  const logIds = res.rows.map(r => Number(r.log_id));
  const logsRes = logIds.length > 0
    ? await systemDb().query<{ id: string; text: string }>(`SELECT id, text FROM bot_outbound_log WHERE id = ANY($1::bigint[])`, [logIds])
    : { rows: [] as { id: string; text: string }[] };
  const textById = new Map(logsRes.rows.map(r => [Number(r.id), r.text]));

  return NextResponse.json({
    rows: res.rows.map(r => ({
      id: Number(r.id),
      shortId: Number(r.log_id).toString(36).toUpperCase(),
      signal: r.signal,
      status: r.status,
      reviewedAt: r.reviewed_at,
      reviewNote: r.review_note,
      createdAt: r.created_at,
      messageText: textById.get(Number(r.log_id)) ?? null,
    })),
  });
}
