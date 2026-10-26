-- «Снять с продажи» отвечал 500 (жалоба владельца 26.10, пользователь Алена Афанасьева):
-- в app.log прода `permission denied for table deals`. lib/sales/unsellDeal.ts делает
-- `UPDATE deals SET sold_at = NULL` (search_path 'sa, public' → sa.deals), а у роли
-- приложения junior_user на sa.deals было только SELECT. Миграция 004 выдала права
-- лишь на sa.manual_fixes (SELECT, INSERT — на месте), UPDATE сделки — нет.
--
-- Выдаём ровно одну колонку, sold_at: других правок сделок приложение не делает,
-- синк Битрикса пишет своей ролью. Повторная накатка безопасна (GRANT идемпотентен).
--
-- Накатка (вручную, как 001–007; junior_user права себе выдать не может):
--   docker exec -i supabase-db psql -U supabase_admin -d postgres \
--     < migrations/sa_org/008_deals_unsell_grant.sql

GRANT UPDATE (sold_at) ON sa.deals TO junior_user;
-- Уже выдано миграцией 004, повторяем для самодостаточности.
GRANT SELECT, INSERT ON sa.manual_fixes TO junior_user;
