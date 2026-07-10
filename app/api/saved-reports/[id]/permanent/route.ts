import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Корзина отчётов (бриф 09.07, п.2): «Удалить навсегда» — настоящий DELETE, только для
// отчёта, УЖЕ лежащего в корзине (deleted_at IS NOT NULL) — из основного списка отчёт
// не удаляется напрямую навсегда, сначала он всегда проходит через мягкое удаление
// (DELETE .../route.ts). Права: свой личный — владелец; витринный — admin
// (action.shared_reports.manage), как и «Восстановить» (та же планка, не супер-админ —
// это уже НЕ обратимая операция, но раз корзина существует специально для страховки от
// случайного удаления, «навсегда» логично доверить тому же admin, кто и так управляет
// витринами).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = systemDb();

  const existing = await db.query<{ user_login: string; is_shared: boolean; deleted_at: Date | null }>(
    `SELECT user_login, is_shared, deleted_at FROM saved_reports WHERE id = $1`,
    [id]
  );
  if (!existing.rows.length) return NextResponse.json({ ok: true }); // уже удалён — идемпотентно
  const row = existing.rows[0];
  if (row.deleted_at === null) {
    return NextResponse.json({ error: 'Отчёт не в корзине — сначала удалите (в корзину)' }, { status: 409 });
  }

  if (row.is_shared) {
    const err = permError(session, 'action.shared_reports.manage');
    if (err) return err;
  } else if (row.user_login !== session.login) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db.query(`DELETE FROM saved_reports WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
