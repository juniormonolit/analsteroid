import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Срок жизни EBALL-начислений в месяцах (TTL ебаллов, 31.07). Дефолт 6 мес.
// Применяется ночным тиком (сгорание source='expiry'); RUB не сгорают.
export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: { ttlMonths?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const v = body.ttlMonths;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > 120) {
    return NextResponse.json({ error: 'Срок жизни — целое число месяцев (1–120)' }, { status: 400 });
  }
  await systemDb().query(`UPDATE badge_coin_settings SET ttl_months = $1, updated_at = now() WHERE id = 1`, [v]);
  return NextResponse.json({ ok: true });
}
