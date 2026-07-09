// Фича «Что изменилось?» (владелец, макет changelog-notifications-mock.html) —
// общая для всех лента изменений + read-state на уровне аккаунта
// (users.changelog_seen_at, миграция 056). См. app/api/changelog/*.

export interface ChangelogEntry {
  id: string;
  publishedAt: string; // ISO, timestamptz
  category: string;
  title: string;
  body: string;
}

export interface ChangelogListResponse {
  entries: ChangelogEntry[];
  unreadCount: number;
  seenAt: string | null;
}
