import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Настройки переводов (пакет 31.07): комиссия (%) и дневной лимит суммы.
export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: { feePercent?: unknown; dailyLimit?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const fee = body.feePercent; const lim = body.dailyLimit;
  if (fee !== undefined && (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0 || fee > 100)) {
    return NextResponse.json({ error: 'Комиссия — число 0..100' }, { status: 400 });
  }
  if (lim !== undefined && (typeof lim !== 'number' || !Number.isInteger(lim) || lim <= 0)) {
    return NextResponse.json({ error: 'Лимит — целое > 0' }, { status: 400 });
  }
  await systemDb().query(
    `UPDATE badge_coin_settings SET transfer_fee_percent = coalesce($1, transfer_fee_percent),
            transfer_daily_limit = coalesce($2, transfer_daily_limit), updated_at = now() WHERE id = 1`,
    [fee ?? null, lim ?? null],
  );
  return NextResponse.json({ ok: true });
}
