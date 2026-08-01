-- 132: Универсальная таблица фиче-флагов (задача владельца 01.08: спрятать таб
-- «Планёрка» без отката кода — «Серёге не понравилось, но код пусть живёт»,
-- включение потом — флагом, без выкатки).
--
-- DOWN:
--   DROP TABLE IF EXISTS feature_flags;

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT
);

-- Планёрка выключена по умолчанию (решение владельца 01.08, отзыв Серёги
-- «не нравится как получилась» — прячем, не удаляем).
INSERT INTO feature_flags (key, enabled, updated_by)
VALUES ('planyorka_enabled', false, 'deploy-132')
ON CONFLICT (key) DO NOTHING;
