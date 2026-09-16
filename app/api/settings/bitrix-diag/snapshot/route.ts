import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Детали снимка: рабочие HTTP-запросы с длительностью, активные SQL, InnoDB, top.
export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const id = Number(req.nextUrl.searchParams.get('id'));
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Нужен id' }, { status: 400 });
  const r = await systemDb().query<Record<string, unknown>>(`SELECT id::text, file, taken_at, severity, flags, detail FROM b24_diag_snapshots WHERE id = $1`, [id]);
  if (!r.rows[0]) return NextResponse.json({ error: 'Снимок не найден' }, { status: 404 });
  return NextResponse.json({ snapshot: r.rows[0] });
}
