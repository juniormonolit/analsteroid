import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { loadIdleWatchRules } from '@/lib/bots/idleWatch';
import { canManageIdleWatch } from '@/features/big-brother/ui/watch/access';
import type { IdleWatchDeliveryDto, IdleWatchSettingsDto } from '@/features/big-brother/ui/watch/shared';

// «Большой брат» → «Сторож»: настройки (idle_watch_settings, миграция 295), правила и журнал последних срабатываний.

export const dynamic = 'force-dynamic';

function missing(e: unknown) {
  return (e as { code?: string })?.code === '42P01';
}

export async function GET() {
  const session = await getSession();
  if (!canManageIdleWatch(session)) return NextResponse.json({ error: 'нет доступа' }, { status: 403 });
  const db = systemDb();
  try {
    const [s, rules, deliveries] = await Promise.all([
      db.query(`SELECT enabled, dry_run, window_start_hour, window_end_hour, mirror_bitrix_user_id, last_tick_at, last_tick_summary
                  FROM idle_watch_settings WHERE id = 1`),
      loadIdleWatchRules(false),
      db.query(
        `SELECT d.id, d.sent_at, c.manager_name, c.manager_bitrix_user_id, c.silence_from, d.minutes_idle, d.rule_name,
                d.recipient_kind, d.recipient_name, d.message, d.dry_run, d.mirrored, d.error
           FROM idle_watch_deliveries d JOIN idle_watch_cases c ON c.id = d.case_id
          ORDER BY d.sent_at DESC LIMIT 100`,
      ),
    ]);
    const r = s.rows[0] ?? {};
    const settings: IdleWatchSettingsDto = {
      enabled: !!r.enabled,
      dryRun: r.dry_run !== false,
      windowStartHour: Number(r.window_start_hour ?? 9),
      windowEndHour: Number(r.window_end_hour ?? 18),
      mirrorBitrixUserId: r.mirror_bitrix_user_id ?? '',
      lastTickAt: r.last_tick_at ? new Date(r.last_tick_at).toISOString() : null,
      lastTickSummary: r.last_tick_summary ?? null,
    };
    const log: IdleWatchDeliveryDto[] = deliveries.rows.map((x) => ({
      id: Number(x.id),
      sentAt: new Date(x.sent_at).toISOString(),
      managerName: x.manager_name,
      managerBitrixUserId: x.manager_bitrix_user_id,
      silenceFrom: new Date(x.silence_from).toISOString(),
      minutesIdle: x.minutes_idle,
      ruleName: x.rule_name,
      recipientKind: x.recipient_kind,
      recipientName: x.recipient_name,
      message: x.message,
      dryRun: x.dry_run,
      mirrored: x.mirrored,
      error: x.error,
    }));
    return NextResponse.json({ settings, rules, deliveries: log });
  } catch (e) {
    if (missing(e)) return NextResponse.json({ error: 'Миграция 295 (idle_watch_*) ещё не накачена' }, { status: 503 });
    throw e;
  }
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!canManageIdleWatch(session)) return NextResponse.json({ error: 'нет доступа' }, { status: 403 });
  const b = (await req.json().catch(() => null)) as Partial<IdleWatchSettingsDto> | null;
  if (!b) return NextResponse.json({ error: 'bad body' }, { status: 400 });

  const mirror = b.mirrorBitrixUserId === undefined ? undefined : String(b.mirrorBitrixUserId ?? '').trim();
  if (mirror && !/^\d+$/.test(mirror)) return NextResponse.json({ error: 'Bitrix ID зеркала — число' }, { status: 400 });
  const hour = (v: unknown, lo: number, hi: number) => v === undefined ? null : (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : NaN);
  const ws = hour(b.windowStartHour, 0, 23);
  const we = hour(b.windowEndHour, 1, 24);
  if (Number.isNaN(ws) || Number.isNaN(we)) return NextResponse.json({ error: 'часы окна — целые 0…24' }, { status: 400 });

  const db = systemDb();
  const cur = await db.query(`SELECT window_start_hour, window_end_hour FROM idle_watch_settings WHERE id = 1`);
  const start = ws ?? cur.rows[0]?.window_start_hour ?? 9;
  const end = we ?? cur.rows[0]?.window_end_hour ?? 18;
  if (end <= start) return NextResponse.json({ error: 'конец окна должен быть позже начала' }, { status: 400 });

  await db.query(
    `UPDATE idle_watch_settings
        SET enabled = COALESCE($1, enabled),
            dry_run = COALESCE($2, dry_run),
            window_start_hour = $3,
            window_end_hour = $4,
            mirror_bitrix_user_id = CASE WHEN $5::boolean THEN $6 ELSE mirror_bitrix_user_id END,
            updated_at = now(), updated_by = $7
      WHERE id = 1`,
    [b.enabled ?? null, b.dryRun ?? null, start, end, mirror !== undefined, mirror || null, session!.login],
  );
  return NextResponse.json({ ok: true });
}
