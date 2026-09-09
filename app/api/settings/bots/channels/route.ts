import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { invalidateBotChannelCache, type BotFunctionConfig } from '@/lib/bitrix/notify';

// Реестр функций бота (задача владельца 09.09; до этого — шесть смысловых каналов,
// задача 09.08). Строка = одна функция: рубильник enabled + настройки config
// (recipients: bitrix id получателей, hour: час МСК). Только супер-админ.
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  try {
    const r = await systemDb().query<{
      key: string; name: string; description: string; bot: string; group_name: string;
      enabled: boolean; config: BotFunctionConfig | null; updated_at: string; updated_by: string | null;
    }>(
      `SELECT key, name, description, bot, group_name, enabled, config, updated_at, updated_by
         FROM bot_channels ORDER BY sort, key`,
    );
    return NextResponse.json({
      functions: r.rows.map(x => ({
        key: x.key, name: x.name, description: x.description, bot: x.bot, group: x.group_name,
        enabled: x.enabled, config: x.config ?? {},
        updatedAt: x.updated_at ? new Date(x.updated_at).toISOString() : null,
        updatedBy: x.updated_by,
      })),
      envOverride: process.env.BOT_SEND_ENABLED === '1',
    });
  } catch (e) {
    console.warn('[bot-functions] GET:', e instanceof Error ? e.message : e);
    return NextResponse.json({ functions: [], envOverride: false, error: 'Нужна миграция 181' });
  }
}

export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const key = String(body.key ?? '').trim();
  if (!key) return NextResponse.json({ error: 'Не указана функция' }, { status: 400 });

  const sets: string[] = ['updated_at = now()', 'updated_by = $2'];
  const params: unknown[] = [key, session!.login];
  if ('enabled' in body) { params.push(Boolean(body.enabled)); sets.push(`enabled = $${params.length}`); }
  if ('config' in body && body.config && typeof body.config === 'object') {
    // Валидируем форму: получатели — только цифровые bitrix id, час — 0..23.
    const raw = body.config as Record<string, unknown>;
    const cfg: BotFunctionConfig = {};
    if (Array.isArray(raw.recipients)) {
      cfg.recipients = raw.recipients.map(v => String(v).trim()).filter(v => /^\d+$/.test(v));
    }
    if (raw.hour !== undefined && raw.hour !== null && raw.hour !== '') {
      const h = Number(raw.hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) return NextResponse.json({ error: 'Час — целое от 0 до 23' }, { status: 400 });
      cfg.hour = h;
    }
    params.push(JSON.stringify(cfg)); sets.push(`config = $${params.length}::jsonb`);
  }
  if (sets.length === 2) return NextResponse.json({ error: 'Нечего менять' }, { status: 400 });

  const r = await systemDb().query(`UPDATE bot_channels SET ${sets.join(', ')} WHERE key = $1`, params);
  if (r.rowCount === 0) return NextResponse.json({ error: 'Функция не найдена' }, { status: 404 });
  invalidateBotChannelCache();
  return NextResponse.json({ ok: true, key });
}
