import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { invalidateBotChannelCache } from '@/lib/bitrix/notify';

// Поканальная глушилка ботов (задача 09.08.2026). Раньше это был флаг в env,
// который правился только на сервере с рестартом; теперь — таблица и переключатели.
// Только супер-админ: канал решает, уйдёт ли сообщение реальным людям в Битрикс.

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  try {
    const r = await systemDb().query<{
      key: string; name: string; description: string; bot: string;
      enabled: boolean; updated_at: string; updated_by: string | null;
    }>(
      `SELECT key, name, description, bot, enabled, updated_at, updated_by
         FROM bot_channels ORDER BY sort, key`,
    );
    return NextResponse.json({
      channels: r.rows.map(x => ({
        key: x.key, name: x.name, description: x.description, bot: x.bot,
        enabled: x.enabled,
        updatedAt: x.updated_at ? new Date(x.updated_at).toISOString() : null,
        updatedBy: x.updated_by,
      })),
      // Аварийный тумблер из окружения: если он поднят, флажки ниже не имеют
      // значения — админ должен это видеть, а не гадать, почему шлётся всё.
      envOverride: process.env.BOT_SEND_ENABLED === '1',
    });
  } catch (e) {
    console.warn('[bot-channels] GET:', e instanceof Error ? e.message : e);
    return NextResponse.json({ channels: [], envOverride: false, error: 'Нужна миграция 170' });
  }
}

export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const key = String(body.key ?? '').trim();
  if (!key) return NextResponse.json({ error: 'Не указан канал' }, { status: 400 });
  const enabled = Boolean(body.enabled);

  const r = await systemDb().query(
    `UPDATE bot_channels SET enabled = $2, updated_at = now(), updated_by = $3 WHERE key = $1`,
    [key, enabled, session!.login],
  );
  if (r.rowCount === 0) return NextResponse.json({ error: 'Канал не найден' }, { status: 404 });
  // Кэш в памяти живёт 30 секунд — сбрасываем, чтобы переключатель сработал
  // сразу, а не «через полминуты, наверное».
  invalidateBotChannelCache();
  return NextResponse.json({ ok: true, key, enabled });
}
