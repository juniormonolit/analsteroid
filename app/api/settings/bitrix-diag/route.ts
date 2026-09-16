import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { keyExists, keyPath } from '@/lib/b24diag/sftp';

// Мониторинг сервера Битрикса: GET — снимки за период (по умолчанию 14 дней), сводка по дням,
// настройки с описаниями, статус синка; PATCH — правка настройки. Только супер-админ.
export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get('days') ?? 14)));
  const db = systemDb();
  const [snaps, byDay, settings, status] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT id::text, file, taken_at, load1, load5, load15, mysql_cpu_pct, mysql_rss_mb, apache_busy, apache_idle, apache_slots, req_per_sec, dur_per_req_ms,
              http_active, http_own, http_working, http_working_max_sec, mysql_active, mysql_long, mysql_max_sec, innodb_history, lock_waits, deadlock_at, severity, flags, alerted_at
         FROM b24_diag_snapshots WHERE taken_at >= now() - ($1 || ' days')::interval ORDER BY taken_at DESC`, [days]),
    db.query<Record<string, unknown>>(
      `SELECT to_char(taken_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day, count(*)::int AS snapshots,
              max(load1)::float AS max_load1, max(apache_busy)::int AS max_busy, sum(mysql_long)::int AS long_total, max(mysql_max_sec)::int AS max_sql_sec,
              sum(lock_waits)::int AS lock_waits, sum(http_own)::int AS http_own, sum(http_active)::int AS http_active,
              count(*) FILTER (WHERE severity = 2)::int AS crit, count(*) FILTER (WHERE severity = 1)::int AS warn
         FROM b24_diag_snapshots WHERE taken_at >= now() - interval '60 days' GROUP BY 1 ORDER BY 1 DESC`),
    db.query<{ key: string; value: unknown; title: string; description: string; group_name: string }>(`SELECT key, value, title, description, group_name FROM b24_diag_settings ORDER BY group_name, key`),
    db.query<{ total: string; last_taken: Date | null; last_synced: Date | null; first_taken: Date | null }>(`SELECT count(*)::text AS total, max(taken_at) AS last_taken, max(synced_at) AS last_synced, min(taken_at) AS first_taken FROM b24_diag_snapshots`),
  ]);
  return NextResponse.json({
    snapshots: snaps.rows, byDay: byDay.rows, settings: settings.rows,
    status: { total: Number(status.rows[0].total), lastTaken: status.rows[0].last_taken, lastSynced: status.rows[0].last_synced, firstTaken: status.rows[0].first_taken, keyPresent: await keyExists(), keyPath: keyPath() },
  });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as { key?: string; value?: unknown } | null;
  if (!body?.key) return NextResponse.json({ error: 'Нужен key' }, { status: 400 });
  const r = await systemDb().query(`UPDATE b24_diag_settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1`, [body.key, JSON.stringify(body.value), session!.login]);
  if (!r.rowCount) return NextResponse.json({ error: 'Нет такой настройки' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
