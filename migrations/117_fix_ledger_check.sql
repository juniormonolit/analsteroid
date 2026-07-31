-- Фикс констрейнта леджера (находка живой проверки 31.07, выкатка 2665):
-- chk_ledger_award_by_source требовал badge_award_id NOT NULL у source='auto',
-- но при УДАЛЕНИИ кастомной награды FK badge_award_id -> badge_awards делает
-- SET NULL (принцип «ебаллы не отзываются», миграция 114) — и auto-строки
-- осиротевшей награды нарушали констрейнт, DELETE определения падал.
-- Новое правило: ручные/конвертация/выплата — всегда без награды; auto — с
-- наградой ИЛИ осиротевшая (NULL после удаления награды, badge_key-снимок есть).
-- СИСТЕМНАЯ БД (YC, dbname=system) — migrations/run_system.mjs.
-- DOWN: вернуть CHECK ((source='auto') = (badge_award_id IS NOT NULL)).

ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_award_by_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_award_by_source
  CHECK (source = 'auto' OR badge_award_id IS NULL);
