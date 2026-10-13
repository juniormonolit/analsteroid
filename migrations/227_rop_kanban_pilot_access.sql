-- 227: «Канбан РОПа» (пилот, задача #9625) — личный доступ трём людям. БД: system.
--
-- Ключ section.rop_kanban_pilot выдаётся ТОЛЬКО через users.section_overrides (персонально),
-- не ролью: проверка в коде — hasRopKanbanPilot() (lib/auth/perms.ts), её не открывают ни
-- джокер section.* (роль «Администратор»), ни супер-админ. Пункт меню «Канбан РОПа (пилот)» и
-- страница /rop-kanban видны только носителям ключа.
--
-- Кому: Михаил (kolosenkov; на деве ещё mikhail.dev), Сергей Афанасьев (bx2098; на деве ещё
-- sergey.dev), Саня = Александр Куликов (kulikov). Общую учётку admin НЕ трогаем — на деве это
-- как раз контрольный «админ без оверрайда». Список логинов сверить на целевой БД перед
-- накатом: SELECT login, display_name FROM users WHERE login IN (...) — несуществующие логины
-- UPDATE молча пропускает.
--
-- Идемпотентна (повторный накат ничего не меняет). Откат:
--   UPDATE users SET section_overrides = array_remove(section_overrides, 'section.rop_kanban_pilot');
UPDATE users
   SET section_overrides = array_append(section_overrides, 'section.rop_kanban_pilot')
 WHERE login IN ('kolosenkov', 'mikhail.dev', 'bx2098', 'sergey.dev', 'kulikov')
   AND NOT (section_overrides @> ARRAY['section.rop_kanban_pilot']);
