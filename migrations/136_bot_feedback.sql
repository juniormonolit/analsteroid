-- 136: Система отладки сообщений «Аналитика» (задача 2765, правка владельца
-- 02.08). Дословно: «Каждому сообщению должен быть присвоен уникальный айди,
-- по которому мы должны иметь возможность разобрать, как и почему оно ушло...
-- Добавь его аккуратно как системную инфу... "В системе могут быть неточности,
-- нажмите кнопку «ошибка»..." ...бонус НЕ автоматический — жалоба падает в
-- очередь на разбор, начисляет админ вручную».
--
-- ID сообщения = base36(bot_outbound_log.id) — не отдельная колонка, чтобы не
-- дублировать источник истины; читаемо (несколько символов) и однозначно
-- обратимо (parseInt(id, 36) для лукапа).
--
-- decision_trace (jsonb) — «след решения»: какие данные/кандидаты
-- рассматривались, какое правило и с какими порогами сработало, почему выбран
-- именно этот клиент/метрика/группа, что проиграло. Формат свободный (разный
-- для digest_daily/digest_weekly/advice_nudge/advice_success/gamification) —
-- потребитель это Артём/Арнольд руками по запросу владельца, не UI-таблица со
-- строгой схемой.
--
-- bot_feedback — очередь на ручной разбор по кнопкам «⚠️ Ошибка»/«👍 Полезно»
-- (imbot-команды advice_error/advice_useful, ONIMCOMMANDADD, тот же паттерн,
-- что уже работает для bind_deal в деал-чатах). Бонус НЕ начисляется
-- автоматически — статус меняет админ в «Настройки → Геймификация →
-- Обратная связь» (защита от фарма кнопки ради MLT).
--
-- DOWN:
--   DROP TABLE IF EXISTS bot_feedback;
--   ALTER TABLE bot_outbound_log DROP COLUMN IF EXISTS decision_trace;

ALTER TABLE bot_outbound_log ADD COLUMN IF NOT EXISTS decision_trace jsonb;

CREATE TABLE IF NOT EXISTS bot_feedback (
  id            bigserial PRIMARY KEY,
  log_id        bigint NOT NULL REFERENCES bot_outbound_log(id),
  bitrix_id     integer NOT NULL,
  signal        text NOT NULL CHECK (signal IN ('error', 'useful')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'bonus_awarded', 'dismissed')),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_feedback_status_idx ON bot_feedback (status);
CREATE UNIQUE INDEX IF NOT EXISTS bot_feedback_log_signal_uq ON bot_feedback (log_id, bitrix_id);
