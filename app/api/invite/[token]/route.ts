import { NextResponse } from 'next/server';
import { systemDb } from '@/lib/db/clients';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = systemDb();

  const res = await db.query<{ display_name: string; expires_at: string; used_at: string | null }>(
    `SELECT u.display_name, it.expires_at, it.used_at
     FROM invite_tokens it
     JOIN users u ON u.id = it.user_id
     WHERE it.token = $1`,
    [token]
  );
  const row = res.rows[0];
  if (!row) return NextResponse.json({ error: 'Приглашение не найдено' }, { status: 404 });
  if (row.used_at) return NextResponse.json({ error: 'Приглашение уже использовано' }, { status: 410 });
  if (new Date(row.expires_at) < new Date()) {
    return NextResponse.json({ error: 'Срок действия приглашения истёк' }, { status: 410 });
  }

  return NextResponse.json({ displayName: row.display_name });
}
