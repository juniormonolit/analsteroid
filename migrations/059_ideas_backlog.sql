-- Фича «Идеи и планы» — бэклог идей от пользователей (макет согласован владельцем:
-- ideas-backlog-mock.html). Та же механика, что «Что изменилось?» (миграция 056,
-- см. lib/db/clients.ts: systemDb() = YC system, там же changelog_entries,
-- saved_reports.shared_section, users.ui_mode — общий паттерн server-side данных).
-- Лента стартует пустой — сида НЕТ (честно, идеи должны быть настоящими).
--
-- БД: YC system (run_system.mjs).

CREATE TABLE IF NOT EXISTS ideas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed', 'planned', 'in_progress', 'done', 'rejected')),
  author_login text NOT NULL,
  author_name  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ideas_status_idx ON ideas (status);
CREATE INDEX IF NOT EXISTS ideas_created_at_idx ON ideas (created_at DESC);
