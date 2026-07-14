import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Отдать байты картинки-вложения. Только залогиненным (инструмент внутренний).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, attId } = await params;
  const res = await systemDb().query<{ data: Buffer; mime_type: string; byte_size: number }>(
    `SELECT data, mime_type, byte_size FROM idea_attachments WHERE id = $1 AND idea_id = $2`,
    [attId, id]
  );
  const row = res.rows[0];
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = new Uint8Array(row.data);
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': row.mime_type,
      'Content-Length': String(row.byte_size),
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

// Удалить вложение: загрузивший его, либо админ общих отчётов, либо супер-админ.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, attId } = await params;
  const db = systemDb();

  const res = await db.query<{ uploaded_by: string }>(
    `SELECT uploaded_by FROM idea_attachments WHERE id = $1 AND idea_id = $2`,
    [attId, id]
  );
  const row = res.rows[0];
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isAdmin = hasPerm(session, 'action.shared_reports.manage');
  if (row.uploaded_by !== session.login && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db.query(`DELETE FROM idea_attachments WHERE id = $1 AND idea_id = $2`, [attId, id]);
  return NextResponse.json({ ok: true });
}
