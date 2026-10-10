-- 226: «Дашборд» (/dashboard-test) — право section.dashboard_test всем ролям (решение Сергея,
-- задача #9395). Раньше раздел видели только админы и роли с явной галкой. Теперь доступ у
-- всех, а данные режутся по срезу сессии (lib/org/sessionScope.ts — тот же механизм, что у
-- «РОП — сегодня»): Администратор — вся компания, Директор/РОП — свои отделы с поддеревом,
-- «Пользователь»/МОП/Логист — только себя.
-- Только выдача права; порядок остальных прав в массиве не меняется. Идемпотентна. БД: system.
-- Откат: UPDATE roles SET permissions = array_remove(permissions, 'section.dashboard_test');
--   (если право было выдано кому-то до миграции — вернуть его вручную по дампу).
UPDATE roles
   SET permissions = array_append(permissions, 'section.dashboard_test')
 WHERE NOT (permissions @> ARRAY['section.dashboard_test']);
