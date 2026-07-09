import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { IDEA_ADMIN_STATUSES, type IdeaStatus } from '@/lib/ideas/types';

// Смена статуса идеи — тот же гейт-уровень «админ», что и для общих отчётов
// («Роп монитор»/«Смекалочная», app/api/saved-reports/[id]/route.ts): право
// action.shared_reports.manage (даёт роль «Администратор») либо супер-админ —
// hasPerm/permError уже учитывает isSuperadmin как проход.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  const err = permError(session, 'action.shared_reports.manage');
  if (err) return err;

  const { id } = await params;
  const body: { status?: string } = await req.json().catch(() => ({}));
  const status = body.status as IdeaStatus | undefined;

  if (!status || !IDEA_ADMIN_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Недопустимый статус' }, { status: 400 });
  }

  const res = await systemDb().query<{ id: string }>(
    `UPDATE ideas SET status = $2, updated_at = now() WHERE id = $1 RETURNING id`,
    [id, status]
  );
  if (!res.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
