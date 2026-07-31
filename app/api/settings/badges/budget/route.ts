import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Месячный бюджет поощрений на руководителя (доп. Серёги 31.07): дефолт 2000,
// 0 = без лимита. При исчерпании кнопка «Поощрить» блокируется до конца месяца.
export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: { monthlyBonusBudget?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const v = body.monthlyBonusBudget;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10_000_000) {
    return NextResponse.json({ error: 'Бюджет — целое число от 0 (0 = без лимита)' }, { status: 400 });
  }
  await systemDb().query(`UPDATE badge_coin_settings SET monthly_bonus_budget = $1, updated_at = now() WHERE id = 1`, [v]);
  return NextResponse.json({ ok: true });
}
