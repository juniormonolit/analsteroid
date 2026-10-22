# MCP-сервер Монолитики — Claude как аналитик

Задача владельца 22.10.2026: директора подключают Монолитику к Claude Desktop / claude.ai и
спрашивают словами («Почему мы не выполнили план?», «Кого поставить на сделки по газику?»).

**Принцип: модель не пишет SQL.** Она вызывает инструменты, которые зовут те же движки, что
и экраны Монолитики. Поэтому цифра в Claude совпадает с цифрой на экране, правила проекта
(тройки «перв./повт./все», «Париж» = самовывоз, зомби-сделки, пороги) применяются сами, а
права режутся тем же срезом сессии (`lib/org/sessionScope.ts`).

## Устройство

| Что | Где |
|---|---|
| MCP-эндпоинт (Streamable HTTP, без состояния, JSON-ответы) | `app/api/mcp/route.ts` |
| Инструменты и инструкции для модели | `lib/mcp/tools.ts` |
| Справочники: оргструктура, словарь, товарные группы, период | `lib/mcp/context.ts` |
| OAuth (Монолитика сама себе authorization server) | `lib/mcp/oauth.ts` |
| Метаданные OAuth (RFC 9728 / 8414) | `app/api/oauth/metadata/*` ← rewrites `/.well-known/*` в `next.config.ts` |
| Регистрация клиента (DCR), обмен токенов, кнопка согласия | `app/api/oauth/{register,token,approve}` |
| Страница «Разрешить Claude доступ?» | `app/oauth/authorize/page.tsx` |
| Таблицы | `migrations/246_mcp.sql` (БД system) |
| Право | `action.mcp` — «Claude (MCP): вопросы к аналитике через ИИ-ассистента» |

### Вход (OAuth)

Claude требует OAuth: статический токен коннектора один на всю организацию, а права у нас
персональные. Как проходит подключение:

1. Claude стучится в `/api/mcp` без токена → 401 с `WWW-Authenticate: Bearer resource_metadata=…`.
2. Читает `/.well-known/oauth-protected-resource/api/mcp` → `/.well-known/oauth-authorization-server`.
3. Регистрируется (`POST /api/oauth/register`). Разрешены только redirect_uri Claude
   (`https://claude.ai/api/mcp/auth_callback`, claude.com) и loopback для Claude Code.
4. Открывает человеку `/oauth/authorize` → вход в Монолитику (`/login?next=…`) → «Разрешить».
5. Меняет code на токены (PKCE S256). Access живёт час, refresh — 60 дней, с ротацией.

В БД хранятся только sha256 токенов. Право `action.mcp` проверяется на каждом запросе: если
его отобрать, уже выданный токен сразу получает 403.

### Инструменты (v1, только чтение)

| Инструмент | Движок | Для чего |
|---|---|---|
| `list_metrics` | `loadMetrics` | каталог с «как считается» и формулой |
| `explain_term` | `mcp_glossary` + `sa.product_groups` | сленг → термины («газик» → Газобетон) |
| `find_org` | `sa.org_resolved_hierarchy`, `availableEntities` | люди, отделы, филиалы в зоне доступа |
| `get_metrics` | `fetchByManagers` / `fetchByProductGroups` + `enrichManagerRowsForMetrics` + `computeTotals` | любые метрики × менеджер/отдел/филиал/товарная группа/итог, со сравнением периодов |
| `get_plan_fact` | `buildMyReportSpec` → `buildReportText` | «% плана» день/неделя/месяц — как отчёт «МОСКВА» |
| `get_decomposition` | `getDecompositionPlanFact` | годовой план против факта по филиалам и категориям (только руководству) |
| `get_manager_rating` | `computeManagerRatings` | рейтинг 0–10 с баллами по осям |
| `get_open_deals` | `getOffloadDeals` | загрузка открытыми сделками, в т.ч. по товарной группе |

Каждый вызов пишется в `mcp_tool_calls` (кто, что, сколько считалось, ошибка). По этой
таблице видно, каких инструментов не хватает.

**Намеренно нет:** произвольного SQL, контактов и телефонов клиентов, звонков и расшифровок
(`va.*`), любых действий на запись.

### Словарь сленга

`mcp_glossary` (system): термин → товарные группы КЦ (`kc_groups`, названия как в
`sa.product_groups`) и «по наибольшему» (`head_group`) или просто пояснение (`kind='term'`).
Стартовый набор — около 80 слов (газик, нерудка, ЖБИ, пустотки, экструдка, повторка…).
Пополняется без деплоя:

```sql
INSERT INTO mcp_glossary (term, kind, meaning, head_group, kc_groups, created_by)
VALUES ('газоблоки', 'product', 'Газобетон', 'Газобетон', '{Газобетон}', 'owner');
```

## Запуск на проде (делает владелец)

1. Миграция: `docker exec -i analsteroid-sys-pg psql -U $POSTGRES_USER -d system -1 < migrations/246_mcp.sql`
   (гранты роли приложения внутри миграции, по образцу `user_sessions`).
2. Выкатка: `deploy.sh` (новых переменных окружения нет; адрес берётся из `APP_BASE_URL`, по
   умолчанию `https://monolitika.mlt-it.com`).
3. Право: «Настройки → Роли» → роли «Директор» (и кому ещё нужно) поставить галочку «Claude (MCP)».
   Супер-админу право не нужно.
4. Подключение в Claude (Team): Owner организации → Organization settings → Connectors → Add →
   Custom → Web, URL `https://monolitika.mlt-it.com/api/mcp`, OAuth — «Register automatically» (DCR).
   Дальше каждый директор: Customize → Connectors → «Монолитика» → Connect → вход в Монолитику → «Разрешить».
5. Проверка: `curl -i -X POST https://monolitika.mlt-it.com/api/mcp` → 401 с `WWW-Authenticate`;
   `curl https://monolitika.mlt-it.com/.well-known/oauth-authorization-server` → JSON.

Исходящие запросы Claude приходят с `160.79.104.0/21`: если перед сервером появится WAF или
фильтр по IP, этот диапазон нужно пропустить.
