import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { runBadgeRecompute } from '@/features/badges/engine/compute';

// Ручной запуск пересчёта наград (кнопка в «Настройки → Награды», супер-админ).
// Пересчёт полный и идемпотентный — безопасно жать сколько угодно раз.
// Взаимоисключение с ночным тиком (instrumentation.ts) — pg_try_advisory_lock
// ВНУТРИ runBadgeRecompute() (задача 2776), этот роут отдельного лока не берёт —
// один источник истины на оба пути. При совпадении с ночным тиком (или с другим
// одновременным нажатием) вернётся stats.skipped=true, а не голый 0/0.
export async function POST() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const stats = await runBadgeRecompute();
  return NextResponse.json({ ok: !stats.skipped, stats });
}
