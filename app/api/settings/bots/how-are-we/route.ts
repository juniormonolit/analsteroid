import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getBotFunctionConfig } from '@/lib/bitrix/notify';
import { fetchHowAreWeSettings } from '@/lib/jobs/howAreWe';
import { PHRASE_BLOCKS } from '@/features/how-are-we/engine/phrases';

// Настройки дайджеста «Как дела?» (вкладка в панели бота «Аналитик»): часы, будни,
// фразы конструктора. Получатели и рубильник живут в реестре функций
// (bot_channels.how_are_we) — их вкладка читает отсюда, а меняет через
// /api/settings/bots/channels. Только супер-админ.
export async function GET() {
  const err = superadminError(await getSession());
  if (err) return err;
  const [settings, cfg, fn] = await Promise.all([
    fetchHowAreWeSettings(),
    getBotFunctionConfig('how_are_we'),
    systemDb().query<{ enabled: boolean }>(`SELECT enabled FROM bot_channels WHERE key = 'how_are_we'`).catch(() => null),
  ]);
  return NextResponse.json({
    settings,
    recipients: cfg.recipients ?? [],
    enabled: fn?.rows[0]?.enabled ?? false,
    blocks: PHRASE_BLOCKS,
  });
}

export async function PUT(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as { hours?: unknown; weekdaysOnly?: unknown; phrases?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });

  const hours = Array.isArray(body.hours) ? [...new Set(body.hours.map(Number).filter(h => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b) : null;
  if (!hours || !hours.length) return NextResponse.json({ error: 'Нужен хотя бы один час отправки' }, { status: 400 });

  const known = new Set(PHRASE_BLOCKS.map(b => b.key));
  const phrases: Record<string, string[]> = {};
  if (body.phrases && typeof body.phrases === 'object') {
    for (const [k, v] of Object.entries(body.phrases as Record<string, unknown>)) {
      if (!known.has(k) || !Array.isArray(v)) continue;
      const list = v.map(x => String(x).trim()).filter(Boolean).slice(0, 30).map(x => x.slice(0, 500));
      if (list.length) phrases[k] = list;
    }
  }
  await systemDb().query(
    `UPDATE how_are_we_settings SET hours = $1, weekdays_only = $2, phrases = $3::jsonb, updated_at = now(), updated_by = $4 WHERE id = 1`,
    [hours, body.weekdaysOnly !== false, JSON.stringify(phrases), session!.login],
  );
  return NextResponse.json({ ok: true });
}
