-- 183: панель управления «Аналитиком» — общий рубильник + журнал ВХОДЯЩИХ. БД: system.
--      Владелец 09.09: «охуенная управленческая панель бота: все отправки, расписания,
--      рубильник „Вырубить бота" и остановить вообще все отправки; лог ответов боту
--      от получателей — хочу видеть, что пишут в ответ».
--
-- Общий рубильник — в bot_settings (миграция 133, там уже живёт dry_run_managers):
-- killed=true → channelEnabled() отвечает false ЛЮБОЙ функции «Аналитика», сколько бы
-- рубильников функций ни было включено. «Контроль звонков» — отдельный бот, его это
-- не касается (правка владельца 09.09, миграция 182).
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS killed    boolean NOT NULL DEFAULT false;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS killed_at timestamptz;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS killed_by text;
COMMENT ON COLUMN bot_settings.killed IS
  'Общий рубильник «Аналитика» (панель /settings/bots/analitik). true — ни одна функция не шлёт, независимо от bot_channels.enabled.';

-- Журнал входящих: всё, что люди пишут боту и на какие кнопки жмут. Раньше
-- входящие только обрабатывались (чаты по сделкам / погода / кнопки) и терялись,
-- если ни один обработчик не признал сообщение своим.
CREATE TABLE IF NOT EXISTS bot_inbound_log (
  id          bigserial PRIMARY KEY,
  bitrix_id   integer NOT NULL,             -- кто написал (FROM_USER_ID)
  event       text NOT NULL,                -- ONIMBOTMESSAGEADD | ONIMCOMMANDADD
  text        text,                         -- текст сообщения или имя команды
  dialog_id   text,
  message_id  bigint,
  reply_to    bigint,                       -- REPLY_ID — на какое сообщение бота отвечали
  handled_by  text NOT NULL,                -- deal_chat | weather | feedback | bind_deal | unhandled
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_inbound_log_created_idx ON bot_inbound_log (created_at DESC);
CREATE INDEX IF NOT EXISTS bot_inbound_log_bitrix_idx  ON bot_inbound_log (bitrix_id);
COMMENT ON TABLE bot_inbound_log IS
  'Входящие боту «Аналитик» (панель управления, 09.09.2026): кто, что, на что отвечал и какой обработчик забрал. unhandled — никто не признал своим.';
