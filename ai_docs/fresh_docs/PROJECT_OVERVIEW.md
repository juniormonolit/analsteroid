# Analsteroid — полное описание проекта

> Хендофф-документ для продолжения работы на новой машине (Mac). Дата: 2026-06-28.
> Это источник правды по архитектуре. Секреты и доступы — в `SECRETS_AND_STORAGE.md` (рядом).

---

## 1. Что это

**Analsteroid** — внутренняя BI-аналитика отдела продаж («аналитика на стероидах»). Дашборды и
конструктор отчётов по сделкам/воронкам, планы продаж, оргструктура. Пользуются им коллеги-руководители.

- **Next.js 16** (App Router, **standalone** output), React 19, TypeScript
- **TailwindCSS v4**, TanStack Query, `pg` (node-postgres)
- xlsx (импорт/экспорт планов), date-fns, zod, zustand, lucide-react
- Прод: VM `62.113.100.67`, порт **8100**, запуск standalone-сервером

### Железные правила (НЕ нарушать)
- **НИКОГДА не дёргаем Битрикс из отчётов.** Данные приходят в БД через outgoing-вебхуки Битрикса. Отчёты читают только из БД.
- **Работаем как пользователь `junior`** на сервере. Креды `danny` использовать строго запрещено.
- **Рабочая директория проекта — только `analsteroid`.** НЕ `anal` и НЕ `anal_v2` (это другие/старые проекты этого же пользователя).
- **Правило сохранения отчёта:** ЛЮБАЯ настройка отчёта (кроме периода и выбора отдела) сохраняется в конфиг отчёта. Сохранённый отчёт открывается ровно в том виде, в каком был построен.

---

## 2. Три базы данных

| В коде | Что хранит | Где / как |
|--------|-----------|-----------|
| **`analyticsDb()`** | Сделки, события, воронки, стадии, товарные группы (схема `sa`) | БД Миши (self-hosted Supabase/Postgres). Локально — через SSH-туннель; на сервере — через `SA_PG_*` env |
| **`systemDb()`** | Оргструктура, отделы, сотрудники, **сохранённые отчёты**, планы менеджеров, рабочий календарь, сессии | Yandex Cloud PostgreSQL, БД `system` |
| **`ycAnalyticsDb()`** | Каталог метрик (`metrics`), доп. аналитика | Yandex Cloud PostgreSQL, БД `analytics` |

Реализация: `lib/db/clients.ts`. `analyticsDb()` использует SA-пул, если задан `SA_PG_USER`, иначе фолбэк на YC `analytics`.

**Доступ к Мишиной БД (обновлено 2026-06-28):** это self-hosted **Supabase** на `62.113.100.67`, ходим через пулер **Supavisor** напрямую (порт 5432, ssl off) — туннель НЕ нужен. Критично: юзер пулера обязан нести суффикс тенанта `junior_user.your-tenant-id` (`your-tenant-id` — реальный дефолтный `POOLER_TENANT_ID`, не плейсхолдер). Креды — в `SECRETS_AND_STORAGE.md`. **Нюанс:** на сервере `SA_PG_*` НЕ заданы, поэтому прод читает сделки из YC `analytics`, а локально — из Supabase (разные источники). Поллеры рвут idle-коннекты — в `clients.ts` на пулах висит `pool.on('error')`.

Полная схема таблиц `sa.*` и `system` — в `../../COWORK_DB_GUIDE.md` (deals, deal_events, funnels, stages, product_groups, org_resolved_hierarchy, departments, employees).

### Ключевые факты по данным
- `sa.deals`: PK `deal_id` (НЕ `id`!), `current_manager_id`, `funnel_id`, `product_group_id`, `head_group_name`, `amount`, и даты-стадии: `created_at`, `reserved_at`, `confirmed_at`, `sold_at`, `delivered_at`, `contact_id` (клиент).
- Воронки: первичные = `is_repeat=false`, повторные = `is_repeat=true`; B2C = funnel_id (0,2), B2B = (1,3).
- Период всегда полуинтервал `[from, to+1day)`.
- `deal_events` НЕ джойнить напрямую к deals (дубли) — через подзапрос/CTE с GROUP BY deal_id.
- Логины менеджеров формата `#2216` (`short_login`) и ФИО (`manager_name`) живут в `org_resolved_hierarchy`, НЕ в `employees`.

---

## 3. Структура кода

```
app/
  (app)/sales/by-managers, by-product-groups, saved/[id]   — страницы отчётов
  (app)/plans            — раздел «Планы»
  (app)/settings         — таблицы, метрики, календарь
  api/
    reports/run          — главный обработчик отчёта (collected SQL → external план → calculated)
    reports/deals        — drill-down список сделок
    saved-reports, saved-reports/[id]   — CRUD сохранённых отчётов
    plans/*              — планы: список, employees, import/export/confirm, settings
    settings/working-calendar           — загрузка производственного календаря РФ
    catalog/metrics, catalog/org-structure
lib/
  db/clients.ts          — пулы трёх БД
  metrics/sqlGen.ts      — генерация SQL для collected-метрик + спец-фильтры (_ppp/_ppo, funnel_type, event_type…)
  metrics/types.ts, format/index.ts
  saved-reports/types.ts — тип SavedReport (источник правды по полям конфига отчёта)
  saved-reports/period.ts
features/reports/ui/      — SalesReportPage, ReportTable, MetricPanel, FilterBar, ReportToolbar,
                            SaveReportModal, HighlightEditor, ViewSettings, DrilldownDrawer
features/plans/ui/        — PlansPage, PlansTable, ImportSlide, ExportSlide
components/layout/AppShell.tsx
migrations/               — *.sql + раннеры run_analytics.mjs / run_system.mjs
certs/yandex-ca.pem       — CA-сертификат YC (в .gitignore через *.pem!)
```

---

## 4. Движок отчётов

Типы метрик (`metric_type` в каталоге `metrics`):
- **`collected`** — собирается SQL'ом из `deals`/`deal_events` через `sqlGen.ts` (`agg_fn`, `agg_field`, `date_field`, `filters`).
- **`calculated`** — формула по другим метрикам (`computeCalculated`), напр. `[sales]/[deals]*100`.
- **`external`** — инъектируется в `app/api/reports/run/route.ts` (плановые метрики), считается ПОСЛЕ collected, но ДО calculated (чтобы `plan_execution_pct` разрешался).

Порядок в `reports/run`: collected SQL → enrich плановыми (`manager_plans` + `working_calendar`) → `computeCalculated`.

### Особые метрики
- **ППП** (Первичная Повторная Продажа) = вторая по хронологии продажа клиента (`contact_id`) по `sold_at`. **ППО** — то же по `delivered_at`. Реализованы спец-фильтрами `_ppp`/`_ppo` в `sqlGen.ts` через window-function (`ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY sold_at) = 2`) — НЕ коррелированный подзапрос (тот давал O(n²) и тормозил).
- Планы: `plan_sales_month`, `plan_shipments_month`, `plan_sales_today`, `plan_shipments_today`, `plan_execution_pct`. План на сегодня = (план/кол-во рабочих дней) × порядковый номер рабочего дня. Рабочие дни — из `working_calendar` (источник `isdayoff.ru`).

---

## 5. Что уже сделано (фичи)

- **Конструктор отчётов**: выбор метрик (панель «Метрики»), порядок (drag), per-metric настройки (подсветка по порогам, режим сравнения, знаки после запятой, порог нейтральности `~`).
- **Закрепление колонок** слева (pinned) — sticky с измеряемыми из DOM offset'ами; разделитель — абсолютная полоска (border-collapse не рисует sticky-границы и не даёт box-shadow на ячейках).
- **Группировка колонок** (надзаголовки групп, как в Google-эталоне): настраивается в панели «Выбрано» (блок «Группы»: добавить/переименовать/удалить + выпадашка группы у метрики). Pinned всегда слева, вне групп. Жирные вертикальные разделители групп — тоже абсолютные полоски.
- **Вид** (тулбар): плотность строк (Компактно/Обычно/Просторно) + размер шрифта. Хранится в **localStorage** (глобально на устройство — зависит от монитора/зрения).
- **Сохранённые отчёты**: CRUD, upsert по имени (совпало имя → перезапись), PUT-редактирование. Все настройки (метрики, порядок, pinned, decimal/threshold overrides, сортировка, группы, режимы) — в конфиге.
- **Планы** (`/plans`): редактируемая таблица, импорт/экспорт xlsx с разрешением конфликтов, фильтр по отделам, группировка.
- **Производственный календарь** (`/settings`): загрузка года с isdayoff.ru.

### Известные незакрытые баги / TODO
- **Sub-pixel «щель» под sticky-шапкой** при дробном вертикальном скролле — данные мелькают. Пробовали box-shadow и `top:-1px` — не помогло, **отложено** (пользователь сказал «потом поправим»).
- ✅ Roadmap Этап 2 (продолжение): **акцент метрики** (жирный + фон колонки, в конфиге отчёта) — СДЕЛАНО 2026-06-28 (`accentedMetricIds`, миграция 025). См. `WORKLOG.md`.
- ✅ Roadmap Этап 3: in-cell бары, тепловая карта по колонке, цветовые темы — СДЕЛАНО 2026-06-28 (миграции 026/027/028). См. `WORKLOG.md`.
- ✅ Roadmap Этап 4: выравнивание чисел опцией, hover-подсветка всей строки — СДЕЛАНО 2026-06-28 (миграция 029). См. `WORKLOG.md`.

---

## 6. Деплой и миграции

- **Деплой:** `bash deploy.sh` (из `analsteroid/`). Билдит standalone, пакует, scp на сервер, рестартит на порту 8100, проверяет `/login`. Ключ `~/.ssh/ssh-key-1777295854643`.
- **Миграции БД:** загрузить sql на сервер и запустить раннер ТАМ (раннеры используют серверные пути к паролю):
  ```bash
  scp -i ~/.ssh/ssh-key-1777295854643 migrations/NNN.sql junior@62.113.100.67:/home/junior/analsteroid/migrations/
  ssh -i ~/.ssh/ssh-key-1777295854643 junior@62.113.100.67 \
    "cd /home/junior/analsteroid && node migrations/run_system.mjs migrations/NNN.sql"
  # run_analytics.mjs — для YC analytics (каталог metrics); run_system.mjs — для YC system
  ```
- Последняя миграция: `031_saved_reports_drilldown.sql` (`drilldown_duplicate_metrics`, `drilldown_metric_ids`, `deal_fields` — конфиг дрилл-дауна). Также 026–030.
- Раннеры на сервере читают пароль из `/home/junior/anal_v2/.pg_password` (путь на СЕРВЕРЕ; это не локальная директория anal_v2).

---

## 7. Связанные проекты
- `system` (github.com/juniormonolit/system) — синхронизация оргструктуры/сотрудников в YC system DB.
