import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Журнал входящих боту «Аналитик» — что люди пишут в ответ (панель, 09.09).
export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Number(sp.get('limit') ?? 200) || 200, 500);
  const q = (sp.get('q') ?? '').trim();
  const r = await systemDb().query<{
    id: string; bitrix_id: number; name: string | null; event: string; text: string | null;
    handled_by: string; reply_to: string | null; created_at: string;
  }>(
    `SELECT l.id::text, l.bitrix_id, u.display_name AS name, l.event, l.text, l.handled_by, l.reply_to::text, l.created_at
       FROM bot_inbound_log l
       LEFT JOIN users u ON u.bitrix_user_id = l.bitrix_id::text
      WHERE ($2 = '' OR l.text ILIKE '%' || $2 || '%' OR u.display_name ILIKE '%' || $2 || '%')
      ORDER BY l.created_at DESC LIMIT $1`,
    [limit, q],
  );
  return NextResponse.json({
    items: r.rows.map(x => ({
      id: x.id, bitrixId: x.bitrix_id, name: x.name, event: x.event, text: x.text,
      handledBy: x.handled_by, replyTo: x.reply_to, createdAt: new Date(x.created_at).toISOString(),
    })),
  });
}
