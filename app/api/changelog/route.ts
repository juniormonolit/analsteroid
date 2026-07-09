import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import type { ChangelogEntry, ChangelogListResponse } from '@/lib/changelog/types';

// Лента «Что изменилось?» — общая для всех, read-state per-account
// (users.changelog_seen_at, миграция 056). Непрочитанные = published_at > seen_at
// (NULL seen_at, т.е. пользователь ни разу не открывал панель, → всё непрочитано).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const [entriesRes, unreadRes, seenRes] = await Promise.all([
    db.query<{ id: string; published_at: Date; category: string; title: string; body: string }>(
      `SELECT id, published_at, category, title, body
         FROM changelog_entries
        ORDER BY published_at DESC`
    ),
    db.query<{ unread_count: number }>(
      `SELECT count(*)::int AS unread_count
         FROM changelog_entries
        WHERE published_at > COALESCE(
          (SELECT changelog_seen_at FROM users WHERE id = $1), '-infinity'::timestamptz
        )`,
      [session.id]
    ),
    db.query<{ changelog_seen_at: Date | null }>(
      `SELECT changelog_seen_at FROM users WHERE id = $1`,
      [session.id]
    ),
  ]);

  const entries: ChangelogEntry[] = entriesRes.rows.map(r => ({
    id: r.id,
    publishedAt: r.published_at.toISOString(),
    category: r.category,
    title: r.title,
    body: r.body,
  }));

  const body: ChangelogListResponse = {
    entries,
    unreadCount: unreadRes.rows[0]?.unread_count ?? 0,
    seenAt: seenRes.rows[0]?.changelog_seen_at?.toISOString() ?? null,
  };
  return NextResponse.json(body);
}
