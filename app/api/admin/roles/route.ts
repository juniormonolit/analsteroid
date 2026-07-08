import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm, sanitizePermissions, superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
  user_count: string;
}

// Список ролей нужен и тем, кто управляет пользователями (дропдаун назначения роли).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isSuperadmin && !hasPerm(session, 'action.users.manage')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = systemDb();
  const res = await db.query<RoleRow>(`
    SELECT r.id, r.name, r.description, r.is_system, r.permissions,
           (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
    FROM roles r
    ORDER BY r.is_system DESC, r.name
  `);

  return NextResponse.json({
    roles: res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: r.is_system,
      permissions: r.permissions,
      userCount: parseInt(r.user_count, 10) || 0,
    })),
  });
}

// Создание/правка ролей — только супер-админ (аккаунт admin), НЕ роль «Администратор».
export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const body = await req.json();
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim() || null;
  const permissions = sanitizePermissions(body.permissions);

  if (!name) return NextResponse.json({ error: 'Укажите название роли' }, { status: 400 });

  const db = systemDb();
  const existing = await db.query(`SELECT id FROM roles WHERE name = $1`, [name]);
  if (existing.rows.length) {
    return NextResponse.json({ error: 'Роль с таким названием уже существует' }, { status: 409 });
  }

  const res = await db.query<{ id: string }>(
    `INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3) RETURNING id`,
    [name, description, permissions]
  );
  return NextResponse.json({ ok: true, id: res.rows[0].id }, { status: 201 });
}
