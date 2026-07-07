import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { createAndSendInvite } from '@/lib/invites/tokens';
import { getPublicOrigin } from '@/lib/http/publicOrigin';

interface UserRow {
  id: string;
  login: string;
  display_name: string;
  is_admin: boolean;
  is_active: boolean;
  bitrix_user_id: string | null;
  invite_expires_at: string | null;
  invite_used_at: string | null;
}

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const db = systemDb();
  const res = await db.query<UserRow>(`
    SELECT u.id, u.login, u.display_name, u.is_admin, u.is_active, u.bitrix_user_id,
           it.expires_at AS invite_expires_at, it.used_at AS invite_used_at
    FROM users u
    LEFT JOIN LATERAL (
      SELECT expires_at, used_at FROM invite_tokens
      WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1
    ) it ON true
    ORDER BY u.display_name
  `);

  const users = res.rows.map((r) => {
    let status: 'active' | 'pending' | 'expired' | 'no_invite' = 'no_invite';
    if (r.is_active) status = 'active';
    else if (r.invite_expires_at && new Date(r.invite_expires_at) > new Date()) status = 'pending';
    else if (r.invite_expires_at) status = 'expired';

    return {
      id: r.id,
      login: r.login,
      displayName: r.display_name,
      isAdmin: r.is_admin,
      isActive: r.is_active,
      bitrixUserId: r.bitrix_user_id,
      status,
    };
  });

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json();
  const login = String(body.login || '').toLowerCase().trim();
  const displayName = String(body.display_name || '').trim();
  const bitrixUserId = String(body.bitrix_user_id || '').trim();
  const isAdmin = Boolean(body.is_admin);

  if (!login || !displayName || !bitrixUserId) {
    return NextResponse.json({ error: 'Заполните логин, имя и сотрудника Bitrix' }, { status: 400 });
  }

  const db = systemDb();

  const existing = await db.query(`SELECT id FROM users WHERE login = $1`, [login]);
  if (existing.rows.length) {
    return NextResponse.json({ error: 'Такой логин уже занят' }, { status: 409 });
  }

  const placeholderHash = await bcrypt.hash(crypto.randomUUID(), 10);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO users (login, password_hash, display_name, is_admin, bitrix_user_id, is_active)
     VALUES ($1, $2, $3, $4, $5, false)
     RETURNING id`,
    [login, placeholderHash, displayName, isAdmin, bitrixUserId]
  );
  const userId = inserted.rows[0].id;

  try {
    await createAndSendInvite(userId, bitrixUserId, displayName, getPublicOrigin(req));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Не удалось отправить приглашение в Bitrix' },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, id: userId }, { status: 201 });
}
