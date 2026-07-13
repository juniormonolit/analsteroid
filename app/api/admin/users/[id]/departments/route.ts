import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { analyticsDb, systemDb } from '@/lib/db/clients';

// Раздел «Руководит» (Права v2): подконтрольные отделы пользователя (сводка
// в его ЛК, в следующей итерации — карточки отдела РОПа). Храним только явно
// отмеченные узлы — дочерние включаются по дереву в коде (user_departments,
// таблица от миграции 049 — переиспользуем, отдельная user_managed_departments
// не заводилась, см. отчёт задачи).
//
// Назначает ТОЛЬКО супер-админ (было action.users.manage — доступно и
// обычным Админам; сужено по спеке Прав v2).

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const { id } = await params;
  // user_departments переехала в sa (задача Серёги 13.07).
  const res = await analyticsDb().query<{ department_id: string }>(
    `SELECT department_id::text AS department_id FROM sa.user_departments WHERE user_id = $1`,
    [id]
  );
  return NextResponse.json({ departmentIds: res.rows.map((r) => r.department_id) });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const rawIds: unknown[] = Array.isArray(body.departmentIds) ? body.departmentIds : [];
  const departmentIds = [...new Set(rawIds.filter((d): d is string => typeof d === 'string'))];

  // users — в system; user_departments/departments переехали в sa (задача Серёги 13.07).
  // Проверка существования пользователя остаётся в system, запись назначений — в sa.
  const user = await systemDb().query(`SELECT id FROM users WHERE id = $1`, [id]);
  if (!user.rows.length) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });

  // Полная замена набора в одной транзакции (пул sa)
  const client = await analyticsDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM sa.user_departments WHERE user_id = $1`, [id]);
    if (departmentIds.length) {
      await client.query(
        `INSERT INTO sa.user_departments (user_id, department_id)
         SELECT $1, d.id FROM sa.departments d WHERE d.id = ANY($2::uuid[])`,
        [id, departmentIds]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return NextResponse.json({ ok: true });
}
