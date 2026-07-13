import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Настройки бота «Контроль звонков» (singleton call_control_settings, миграция 098).
// Гейт section.settings — как «Шаблоны карточек»: админ видит и меняет (решение
// Иосифа 13.07: правила/шаблоны он настраивает сам, супер-админ-only не нужен).

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const db = systemDb();
  const [settings, counts] = await Promise.all([
    db.query(
      `SELECT enabled, dry_run, mirror_bitrix_user_id FROM call_control_settings WHERE id = 1`
    ),
    db.query(
      `SELECT
         (SELECT count(*) FROM call_events WHERE received_at > now() - interval '24 hours') AS events_24h,
         (SELECT max(received_at) FROM call_events) AS last_event_at,
         (SELECT count(*) FROM call_control_cases WHERE status = 'open') AS open_cases`
    ),
  ]);
  const s = settings.rows[0] ?? {};
  const c = counts.rows[0] ?? {};
  return NextResponse.json({
    enabled: !!s.enabled,
    dryRun: s.dry_run !== false,
    mirrorBitrixUserId: s.mirror_bitrix_user_id ?? '',
    eventsLast24h: Number(c.events_24h ?? 0),
    lastEventAt: c.last_event_at ?? null,
    openCases: Number(c.open_cases ?? 0),
  });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const body = await req.json().catch(() => null) as
    { enabled?: boolean; dryRun?: boolean; mirrorBitrixUserId?: string } | null;
  if (!body) return NextResponse.json({ error: 'bad body' }, { status: 400 });

  const mirror = (body.mirrorBitrixUserId ?? '').trim();
  if (mirror && !/^\d+$/.test(mirror)) {
    return NextResponse.json({ error: 'Bitrix ID зеркала — число' }, { status: 400 });
  }

  const db = systemDb();
  await db.query(
    `UPDATE call_control_settings
     SET enabled = COALESCE($1, enabled),
         dry_run = COALESCE($2, dry_run),
         mirror_bitrix_user_id = $3,
         updated_at = now()
     WHERE id = 1`,
    [body.enabled ?? null, body.dryRun ?? null, mirror || null]
  );
  return NextResponse.json({ ok: true });
}
