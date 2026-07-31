import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { runBadgeRecompute } from '@/features/badges/engine/compute';

// Ручной запуск пересчёта наград (кнопка в «Настройки → Награды», супер-админ).
// Пересчёт полный и идемпотентный — безопасно жать сколько угодно раз.
export async function POST() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const stats = await runBadgeRecompute();
  return NextResponse.json({ ok: true, stats });
}
