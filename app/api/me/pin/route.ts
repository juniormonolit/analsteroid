import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import {
  actorFromSession, getPinState, hashPin, pinFeatureEnabled, pinFormatError, verifyPin,
  PIN_DEFAULT_THRESHOLD_MLT, PIN_FREEZE_HOURS,
} from '@/lib/auth/pin';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';

// Установка / смена пина / изменение личного порога (задача #2995, спека
// owners-inbox/monolitika-pin-code-spec.md §4/§5). GET — состояние для UI,
// POST — первичная установка (пин дважды + пароль аккаунта, для SSO-логинов
// bx* пароль не нужен), PATCH — смена пина ИЛИ изменение порога, обе ВСЕГДА
// требуют ввода текущего пина.

const SSO_LOGIN_RE = /^bx\d+$/;

async function verifyAccountPassword(userId: string, password: unknown): Promise<string | null> {
  if (typeof password !== 'string' || !password) return 'Введите пароль аккаунта';
  const r = await systemDb().query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  if (!r.rows.length) return 'Пользователь не найден';
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  return ok ? null : 'Неверный пароль аккаунта';
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const state = await getPinState(systemDb(), session.id);
  return NextResponse.json({ ...state, pinFeatureEnabled: pinFeatureEnabled() });
}

// POST: первичная установка пина. {pin, pinConfirm, password?}
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!pinFeatureEnabled()) return NextResponse.json({ error: 'Подтверждение пином временно недоступно' }, { status: 503 });

  let body: { pin?: unknown; pinConfirm?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const existing = await systemDb().query<{ pin_hash: string | null }>(`SELECT pin_hash FROM users WHERE id = $1`, [session.id]);
  if (existing.rows[0]?.pin_hash) {
    return NextResponse.json({ error: 'Пин уже установлен — используйте смену пина' }, { status: 400 });
  }

  const pin = body.pin;
  if (typeof pin !== 'string') return NextResponse.json({ error: 'Введите пин' }, { status: 400 });
  const fmtErr = pinFormatError(pin);
  if (fmtErr) return NextResponse.json({ error: fmtErr }, { status: 400 });
  if (body.pinConfirm !== pin) return NextResponse.json({ error: 'Пины не совпадают' }, { status: 400 });

  // SSO-аккаунт (bx<id>) — пароля не существует (спека §5), для остальных пароль обязателен.
  if (!SSO_LOGIN_RE.test(session.login)) {
    const pwErr = await verifyAccountPassword(session.id, body.password);
    if (pwErr) return NextResponse.json({ error: pwErr }, { status: 403 });
  }

  const hash = await hashPin(pin);
  const freezeUntil = new Date(Date.now() + PIN_FREEZE_HOURS * 3600_000);
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET pin_hash = $2, pin_set_at = now(), pin_source = 'self',
              pin_fail_count = 0, pin_lock_level = 0, pin_locked_until = NULL,
              pin_threshold_mlt = $3, pin_freeze_until = $4
        WHERE id = $1`,
      [session.id, hash, PIN_DEFAULT_THRESHOLD_MLT, freezeUntil.toISOString()],
    );
    const actor = actorFromSession(session, req);
    await client.query(
      `INSERT INTO wallet_pin_events (user_id, bitrix_id, event, operation, surface, ip, user_agent, actor_login)
       VALUES ($1,$2,'set','pin_set',$3,$4,$5,$6)`,
      [actor.userId, actor.bitrixId, actor.surface, actor.ip, actor.userAgent, actor.login],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, pinFreezeUntil: freezeUntil.toISOString(), pinThresholdMlt: PIN_DEFAULT_THRESHOLD_MLT });
}

// PATCH: {action:'change', oldPin, newPin, newPinConfirm, password?}
//      | {action:'threshold', pin, thresholdMlt}
// Обе ветки ВСЕГДА требуют текущий пин (спека §4: «изменение порога требует
// ввода пина. Это ключевая деталь» — и повышение, и понижение).
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!pinFeatureEnabled()) return NextResponse.json({ error: 'Подтверждение пином временно недоступно' }, { status: 503 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const existing = await systemDb().query<{ pin_hash: string | null }>(`SELECT pin_hash FROM users WHERE id = $1`, [session.id]);
  if (!existing.rows[0]?.pin_hash) {
    return NextResponse.json({ error: 'Пин не установлен' }, { status: 428 });
  }

  const actor = actorFromSession(session, req);

  if (body.action === 'change') {
    const oldPin = body.oldPin;
    const newPin = body.newPin;
    if (typeof oldPin !== 'string') return NextResponse.json({ error: 'Введите текущий пин' }, { status: 400 });
    const verified = await verifyPin(systemDb(), actor, oldPin, { operation: 'pin_change' });
    if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: verified.status });

    if (typeof newPin !== 'string') return NextResponse.json({ error: 'Введите новый пин' }, { status: 400 });
    const fmtErr = pinFormatError(newPin);
    if (fmtErr) return NextResponse.json({ error: fmtErr }, { status: 400 });
    if (body.newPinConfirm !== newPin) return NextResponse.json({ error: 'Пины не совпадают' }, { status: 400 });

    if (!SSO_LOGIN_RE.test(session.login)) {
      const pwErr = await verifyAccountPassword(session.id, body.password);
      if (pwErr) return NextResponse.json({ error: pwErr }, { status: 403 });
    }

    const hash = await hashPin(newPin);
    const freezeUntil = new Date(Date.now() + PIN_FREEZE_HOURS * 3600_000);
    const client = await systemDb().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET pin_hash = $2, pin_set_at = now(), pin_source = 'self',
                pin_fail_count = 0, pin_lock_level = 0, pin_locked_until = NULL, pin_freeze_until = $3
          WHERE id = $1`,
        [session.id, hash, freezeUntil.toISOString()],
      );
      await client.query(
        `INSERT INTO wallet_pin_events (user_id, bitrix_id, event, operation, surface, ip, user_agent, actor_login)
         VALUES ($1,$2,'change','pin_change',$3,$4,$5,$6)`,
        [actor.userId, actor.bitrixId, actor.surface, actor.ip, actor.userAgent, actor.login],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return NextResponse.json({ ok: true, pinFreezeUntil: freezeUntil.toISOString() });
  }

  if (body.action === 'threshold') {
    const pin = body.pin;
    if (typeof pin !== 'string') return NextResponse.json({ error: 'Введите пин' }, { status: 400 });
    const thresholdMlt = body.thresholdMlt;
    if (typeof thresholdMlt !== 'number' || !Number.isInteger(thresholdMlt) || thresholdMlt < 0 || thresholdMlt > 100) {
      return NextResponse.json({ error: 'Порог — целое число от 0 до 100' }, { status: 400 });
    }

    const before = await systemDb().query<{ pin_threshold_mlt: number }>(`SELECT pin_threshold_mlt FROM users WHERE id = $1`, [session.id]);
    const thresholdBefore = before.rows[0]?.pin_threshold_mlt ?? PIN_DEFAULT_THRESHOLD_MLT;

    const verified = await verifyPin(systemDb(), actor, pin, {
      operation: 'threshold_change', thresholdBefore, thresholdAfter: thresholdMlt,
    });
    if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: verified.status });

    const client = await systemDb().connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE users SET pin_threshold_mlt = $2 WHERE id = $1`, [session.id, thresholdMlt]);
      await client.query(
        `INSERT INTO wallet_pin_events
           (user_id, bitrix_id, event, operation, threshold_before, threshold_after, surface, ip, user_agent, actor_login)
         VALUES ($1,$2,'threshold_change','threshold_change',$3,$4,$5,$6,$7,$8)`,
        [actor.userId, actor.bitrixId, thresholdBefore, thresholdMlt, actor.surface, actor.ip, actor.userAgent, actor.login],
      );
      // «Тихо поднять порог невозможно» — уведомление владельцу аккаунта в обе стороны (спека §4).
      if (actor.bitrixId !== null) {
        await createNotification(client, {
          bitrixId: actor.bitrixId, type: 'pin_threshold_change',
          title: `Порог пина изменён: ${thresholdBefore} → ${thresholdMlt} MLT`,
          body: 'Если это были не вы — смените пароль и пин, позовите администратора.',
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
    if (actor.bitrixId !== null) {
      void pushViaAnalitik(actor.bitrixId, `🔧 Порог пина изменён: ${thresholdBefore} → ${thresholdMlt} MLT`,
        'Если это были не вы — смените пароль и пин.');
    }
    return NextResponse.json({ ok: true, pinThresholdMlt: thresholdMlt });
  }

  return NextResponse.json({ error: "action: 'change' | 'threshold'" }, { status: 400 });
}
