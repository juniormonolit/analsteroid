ALTER TABLE saved_reports
  ADD CONSTRAINT saved_reports_user_name_unique UNIQUE (user_login, name);
