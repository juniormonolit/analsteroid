import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError, sanitizeSectionOverrides } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Права v2: персональные исключения видимости разделов (union с правами роли,
// см. lib/auth/session.ts). Выдавать могут и админы, и супер-админ —
// action.users.manage (супер-админ всегда проходит через hasPerm).

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  const { id } = await params;
  const res = await systemDb().query<{ section_overrides: string[] }>(
    `SELECT section_overrides FROM users WHERE id = $1`,
    [id]
  );
  if (!res.rows.length) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });
  return NextResponse.json({ sectionOverrides: res.rows[0].section_overrides ?? [] });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const sectionOverrides = sanitizeSectionOverrides(body.sectionOverrides);

  const db = systemDb();
  const res = await db.query(
    `UPDATE users SET section_overrides = $1 WHERE id = $2 RETURNING id`,
    [sectionOverrides, id]
  );
  if (!res.rows.length) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
