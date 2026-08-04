import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { PIN_DEFAULT_THRESHOLD_MLT, PIN_FREEZE_HOURS } from '@/lib/auth/pin';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';

// Сброс пина администратором (задача #2995, спека §5). Только
// action.users.manage (РОП этого права не имеет — он же одобряет выплаты и
// активации, сброс в те же руки был бы полным контролем над чужим кошельком,
// спека явно исключает РОПа). НЕ задаёт новый пин — обнуляет pin_hash,
// возвращает порог к дефолту, замораживает вывод наружу на 24ч, уведомляет
// сотрудника двумя каналами, пишет в журнал логин того, кто сбрасывал.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied as NextResponse;

  const { id } = await params;
  const target = await systemDb().query<{ id: string; bitrix_user_id: string | null; pin_hash: string | null }>(
    `SELECT id, bitrix_user_id, pin_hash FROM users WHERE id = $1`, [id],
  );
  if (target.rowCount === 0) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });
  if (!target.rows[0].pin_hash) return NextResponse.json({ error: 'У этого пользователя пин не установлен' }, { status: 400 });

  const bitrixId = target.rows[0].bitrix_user_id ? Number(target.rows[0].bitrix_user_id) : null;
  const freezeUntil = new Date(Date.now() + PIN_FREEZE_HOURS * 3600_000);

  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET pin_hash = NULL, pin_source = 'admin_reset', pin_set_at = NULL,
              pin_fail_count = 0, pin_lock_level = 0, pin_locked_until = NULL,
              pin_threshold_mlt = $2, pin_freeze_until = $3
        WHERE id = $1`,
      [id, PIN_DEFAULT_THRESHOLD_MLT, freezeUntil.toISOString()],
    );
    await client.query(
      `INSERT INTO wallet_pin_events (user_id, bitrix_id, event, operation, threshold_after, actor_login)
       VALUES ($1,$2,'reset_by_admin','pin_reset_by_admin',$3,$4)`,
      [id, bitrixId, PIN_DEFAULT_THRESHOLD_MLT, session!.login],
    );
    if (bitrixId !== null) {
      await createNotification(client, {
        bitrixId, type: 'pin_reset_by_admin',
        title: 'Пин сброшен администратором',
        body: `Сбросил: ${session!.login}. Задайте новый пин в профиле. На 24 часа заморожены переводы, подарки и вывод в ЗП.`,
        link: '/profile',
      });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (bitrixId !== null) {
    void pushViaAnalitik(bitrixId, '🔓 Пин сброшен администратором',
      `Сбросил: ${session!.login}. Задайте новый пин в профиле. На 24ч заморожены переводы/подарки/вывод в ЗП.`);
  }
  return NextResponse.json({ ok: true, pinFreezeUntil: freezeUntil.toISOString(), pinThresholdMlt: PIN_DEFAULT_THRESHOLD_MLT });
}
