import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// «Название валюты» (задача 2657, глобальная настройка, дефолт «ебаллы») —
// правится в «Настройки → Награды», только супер-админ. UI везде берёт название
// из ответов /api/badges/* (getCurrencyName).
export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  let body: { currencyName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }
  if (typeof body.currencyName !== 'string' || !body.currencyName.trim()) {
    return NextResponse.json({ error: 'currencyName: непустая строка' }, { status: 400 });
  }
  await systemDb().query(
    `UPDATE badge_coin_settings SET currency_name = $1, updated_at = now() WHERE id = 1`,
    [body.currencyName.trim().slice(0, 40)],
  );
  return NextResponse.json({ ok: true });
}
