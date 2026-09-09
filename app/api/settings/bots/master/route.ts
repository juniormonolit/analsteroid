import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { invalidateBotChannelCache } from '@/lib/bitrix/notify';
import { invalidateDryRunCache } from '@/features/badges/engine/notifications';

// Общие рубильники «Аналитика» (панель управления, 09.09):
//   killed — «Вырубить бота»: молчит всё, независимо от функций (bot_settings.killed);
//   dryRunManagers — тест-режим сообщений менеджерам (bot_settings.dry_run_managers,
//     миграция 133): дайджесты/награды считаются и пишутся в журнал исходящих, но не
//     уходят. Раньше этот флаг был скрыт от владельца и включён по умолчанию —
//     третья, невидимая причина «почему бот молчит».
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const r = await systemDb().query<{ killed: boolean; killed_at: string | null; killed_by: string | null; dry_run_managers: boolean }>(
    `SELECT killed, killed_at, killed_by, dry_run_managers FROM bot_settings WHERE id = 1`,
  );
  const row = r.rows[0];
  return NextResponse.json({
    killed: row?.killed ?? false,
    killedAt: row?.killed_at ? new Date(row.killed_at).toISOString() : null,
    killedBy: row?.killed_by ?? null,
    dryRunManagers: row?.dry_run_managers ?? true,
    envOverride: process.env.BOT_SEND_ENABLED === '1',
  });
}

export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  const sets: string[] = ['updated_at = now()', 'updated_by = $1'];
  const params: unknown[] = [session!.login];
  if ('killed' in body) {
    const killed = Boolean(body.killed);
    params.push(killed); sets.push(`killed = $${params.length}`);
    sets.push(killed ? 'killed_at = now(), killed_by = $1' : 'killed_at = NULL, killed_by = NULL');
  }
  if ('dryRunManagers' in body) { params.push(Boolean(body.dryRunManagers)); sets.push(`dry_run_managers = $${params.length}`); }
  if (sets.length === 2) return NextResponse.json({ error: 'Нечего менять' }, { status: 400 });
  await systemDb().query(`UPDATE bot_settings SET ${sets.join(', ')} WHERE id = 1`, params);
  invalidateBotChannelCache();
  invalidateDryRunCache();
  return NextResponse.json({ ok: true });
}
