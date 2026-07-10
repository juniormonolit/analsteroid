import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Корзина отчётов (бриф 09.07, п.2): восстановление — снимает deleted_at/deleted_by.
// Права те же, что у «переместить в корзину» (DELETE .../route.ts): свой личный отчёт —
// владелец; витринный — admin (action.shared_reports.manage).
export async function POST(
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
  if (!existing.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const row = existing.rows[0];
  if (row.deleted_at === null) return NextResponse.json({ ok: true }); // уже не в корзине — идемпотентно

  if (row.is_shared) {
    const err = permError(session, 'action.shared_reports.manage');
    if (err) return err;
  } else if (row.user_login !== session.login) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await db.query(`UPDATE saved_reports SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [id]);
  } catch (err) {
    // Партиционный unique-индекс (058/055, сужен 069) может конфликтовать, если пока
    // отчёт лежал в корзине, кто-то занял то же имя новым отчётом — восстановить
    // с тем же именем в этом случае нельзя.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'Отчёт с таким названием уже существует — переименуйте перед восстановлением' },
        { status: 409 }
      );
    }
    console.error('[saved-reports/restore] failed:', err);
    return NextResponse.json({ error: 'Не удалось восстановить отчёт' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
