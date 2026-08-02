import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Курс конвертации RUB → EBALL (доп. Серёги 31.07). Дефолт 1 ₽ = 1 ебалл.
// Меняет только БУДУЩИЕ конвертации — прошлые зафиксированы в леджере.
export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: { rubToEballRate?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const v = body.rubToEballRate;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1000) {
    return NextResponse.json({ error: 'Курс — число больше нуля (MLT за 1 ₽)' }, { status: 400 });
  }
  await systemDb().query(`UPDATE badge_coin_settings SET rub_to_eball_rate = $1, updated_at = now() WHERE id = 1`, [v]);
  return NextResponse.json({ ok: true });
}
