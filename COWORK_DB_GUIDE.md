# Инструкция по подключению к БД аналитики Analsteroid

> Передай этот файл в Cowork. Подставь пароли сам (см. секцию «Credentials»).

---

## 1. Архитектура: три базы данных

| Имя | Что хранит | Как подключиться |
|-----|-----------|-----------------|
| **analyticsDb** (БД Миши) | Сделки, события, воронки, товарные группы | SSH-туннель → localhost:5432 |
| **systemDb** (YC system) | Оргструктура, отделы, сотрудники, сохранённые отчёты | Прямое подключение к Яндекс Cloud |
| **ycAnalyticsDb** (YC analytics) | Планы продаж, доп. метрики | То же что system, другая БД |

---

## 2. Credentials — подставь сам

Открой на сервере: `cat /home/junior/analsteroid/.env.local`

### БД Миши (analyticsDb)
```
host:     SA_PG_HOST (обычно 127.0.0.1 или внутренний IP)
port:     SA_PG_PORT (обычно 5432)
user:     SA_PG_USER
password: SA_PG_PASSWORD
database: postgres
schema:   sa
ssl:      false
```

Подключение через SSH-туннель с локальной машины:
```bash
ssh -i C:/Users/junio/.ssh/ssh-key-1777295854643 \
    -L 5433:<SA_PG_HOST>:5432 \
    -N junior@62.113.100.67
# Затем подключайся на localhost:5433
```

### YC system DB (systemDb)
```
host:     rc1b-o2tqrr9j3gq09svq.mdb.yandexcloud.net
port:     6432
user:     JanCloude
password: <YC_PG_PASSWORD из .env.local>
database: system
ssl:      true  (rejectUnauthorized: false)
```

### YC analytics DB (ycAnalyticsDb)
```
Те же host/port/user/password что у system
database: analytics
ssl:      true
```

---

## 3. Схема БД Миши (schema: sa)

### Таблица `sa.deals` — главная таблица сделок

| Колонка | Тип | Описание |
|---------|-----|----------|
| `deal_id` | int | PK сделки |
| `current_manager_id` | int | Bitrix user_id текущего менеджера |
| `funnel_id` | int | ID воронки (см. ниже) |
| `product_group_id` | int | ID товарной группы (КЦ-категория) |
| `head_group_name` | text | Категория по каталогу (по максимальной позиции) |
| `amount` | numeric | Сумма сделки |
| `created_at` | timestamptz | Дата создания (входящий лид) |
| `reserved_at` | timestamptz | Дата брони |
| `confirmed_at` | timestamptz | Дата подтверждения брони |
| `sold_at` | timestamptz | Дата продажи |
| `delivered_at` | timestamptz | Дата отгрузки |

### Таблица `sa.deal_events` — события по сделкам

| Колонка | Тип | Описание |
|---------|-----|----------|
| `deal_id` | int | FK → deals.deal_id |
| `stage_id` | int | FK → stages.id |
| `event_at` | timestamptz | Время события |

### Таблица `sa.funnels` — воронки

| id | name | is_repeat | Клиент |
|----|------|-----------|--------|
| 0 | Частные лица | false | B2C |
| 1 | Юрлица | false | B2B |
| 2 | Повторные B2C | true | B2C |
| 3 | Повторные B2B | true | B2B |
| 4 | Холодные звонки | false | — |
| 7 | Тендеры | false | — |

**Первичные сделки** = `funnel_id IN (SELECT id FROM sa.funnels WHERE is_repeat = false)`  
**Повторные сделки** = `funnel_id IN (SELECT id FROM sa.funnels WHERE is_repeat = true)`  
**B2C** = `funnel_id IN (0, 2)`  
**B2B** = `funnel_id IN (1, 3)`

### Таблица `sa.stages` — стадии / типы событий

| event_type | Значение |
|------------|----------|
| `'called'` | Созвонился (факт звонка) |

### Таблица `sa.product_groups` — товарные группы (КЦ)

```sql
SELECT id, name FROM sa.product_groups;
```

---

## 4. Схема БД system (YC)

### `org_resolved_hierarchy` — плоская оргструктура

| Колонка | Описание |
|---------|----------|
| `manager_bitrix_user_id` | Bitrix user_id менеджера (совпадает с deals.current_manager_id) |
| `manager_name` | ФИО менеджера |
| `department_id` | UUID отдела |
| `department_name` | Название отдела |
| `rop_bitrix_user_id` | Bitrix user_id РОПа |
| `is_active` | Активен ли сотрудник |

**Только продажники** (фильтр по отделам) — получи список через:
```sql
SELECT DISTINCT department_id, department_name
FROM org_resolved_hierarchy
WHERE is_active = true
ORDER BY department_name;
```

### `employees` — сотрудники

| Колонка | Описание |
|---------|----------|
| `bitrix_user_id` | Bitrix user_id |
| `department_id` | UUID отдела |
| `name` | ФИО |

### `departments` — отделы

| Колонка | Описание |
|---------|----------|
| `id` | UUID |
| `bitrix_department_id` | ID отдела в Битриксе |
| `name` | Название |

### `saved_reports` — сохранённые отчёты пользователей

```sql
SELECT id, user_login, name, report_slug, created_at
FROM saved_reports
ORDER BY created_at DESC;
```

---

## 5. Метрики и как их считать

Все метрики считаются за период `[from, to)` — т.е. `>= from AND < (to + 1 день)`.

### Собранные метрики (из deals)

```sql
-- Первичных сделок (входящих)
COUNT(DISTINCT CASE WHEN d.created_at >= $from AND d.created_at < $to
  AND d.funnel_id IN (SELECT id FROM sa.funnels WHERE is_repeat = false)
  THEN d.deal_id END) AS primary_deals_count

-- Брони
COUNT(DISTINCT CASE WHEN d.reserved_at >= $from AND d.reserved_at < $to
  THEN d.deal_id END) AS reservations_count

-- Подтверждённые брони
COUNT(DISTINCT CASE WHEN d.confirmed_at >= $from AND d.confirmed_at < $to
  THEN d.deal_id END) AS confirmed_reservations_count

-- Продаж (шт)
COUNT(DISTINCT CASE WHEN d.sold_at >= $from AND d.sold_at < $to
  AND d.funnel_id IN (SELECT id FROM sa.funnels WHERE is_repeat = false)
  THEN d.deal_id END) AS primary_sales_count

-- Сумма продаж
SUM(CASE WHEN d.sold_at >= $from AND d.sold_at < $to
  AND d.funnel_id IN (SELECT id FROM sa.funnels WHERE is_repeat = false)
  THEN d.amount ELSE 0 END) AS primary_sales_amount

-- Отгрузок (шт)
COUNT(DISTINCT CASE WHEN d.delivered_at >= $from AND d.delivered_at < $to
  THEN d.deal_id END) AS primary_shipments_count

-- Сумма отгрузок
SUM(CASE WHEN d.delivered_at >= $from AND d.delivered_at < $to
  THEN d.amount ELSE 0 END) AS primary_shipments_amount

-- Созвонился (через deal_events — отдельным CTE!)
WITH called AS (
  SELECT deal_id FROM sa.deal_events
  WHERE event_at >= $from AND event_at < $to
    AND stage_id IN (SELECT id FROM sa.stages WHERE event_type = 'called')
  GROUP BY deal_id
)
COUNT(DISTINCT CASE WHEN c.deal_id IS NOT NULL THEN d.deal_id END) AS called_deals_count
```

### Вычисляемые метрики (CR)

| Метрика | Формула |
|---------|---------|
| CR обзвона | `called / primary_deals * 100` |
| CR брони | `reservations / called * 100` |
| CR подтв. | `confirmed / reservations * 100` |
| CR продажи | `primary_sales / confirmed * 100` |
| CR отгрузки | `shipments / primary_sales * 100` |
| Средний чек | `primary_sales_amount / primary_sales_count` |

---

## 6. Типовые запросы

### Сделки по менеджеру за период

```sql
-- Подключись к БД Миши (schema sa)
-- Период: например июнь 2026
SELECT
  d.current_manager_id,
  h.manager_name,
  h.department_name,
  COUNT(DISTINCT CASE WHEN d.created_at >= '2026-06-01' AND d.created_at < '2026-07-01'
    AND d.funnel_id IN (SELECT id FROM sa.funnels WHERE is_repeat = false)
    THEN d.deal_id END) AS primary_deals,
  COUNT(DISTINCT CASE WHEN d.sold_at >= '2026-06-01' AND d.sold_at < '2026-07-01'
    THEN d.deal_id END) AS sales,
  SUM(CASE WHEN d.sold_at >= '2026-06-01' AND d.sold_at < '2026-07-01'
    THEN d.amount ELSE 0 END) AS sales_amount
FROM sa.deals d
-- org hierarchy берётся из system DB — подставь вручную или join через dblink
WHERE d.current_manager_id IS NOT NULL
  AND (
    (d.created_at >= '2026-06-01' AND d.created_at < '2026-07-01')
    OR (d.sold_at >= '2026-06-01' AND d.sold_at < '2026-07-01')
    OR (d.delivered_at >= '2026-06-01' AND d.delivered_at < '2026-07-01')
  )
GROUP BY d.current_manager_id, h.manager_name, h.department_name
ORDER BY sales_amount DESC;
```

### Итого по компании за период

```sql
SELECT
  COUNT(DISTINCT CASE WHEN d.created_at >= '2026-06-01' AND d.created_at < '2026-07-01'
    AND d.funnel_id IN (SELECT id FROM sa.funnels WHERE is_repeat = false)
    THEN d.deal_id END) AS primary_deals,
  COUNT(DISTINCT CASE WHEN d.sold_at >= '2026-06-01' AND d.sold_at < '2026-07-01'
    THEN d.deal_id END) AS sales,
  SUM(CASE WHEN d.sold_at >= '2026-06-01' AND d.sold_at < '2026-07-01'
    THEN d.amount ELSE 0 END) AS sales_amount
FROM sa.deals d;
```

### Список менеджеров из оргструктуры (system DB)

```sql
SELECT manager_bitrix_user_id, manager_name, department_name
FROM org_resolved_hierarchy
WHERE is_active = true
ORDER BY department_name, manager_name;
```

---

## 7. Важные ограничения

- **Отчёт работает только по отделам продаж** — менеджеры из Снабжения, HR и т.п. исключаются через фильтр по `department_id` из `org_resolved_hierarchy`
- **НЕ дёргать Битрикс** — все данные только из локальной БД
- **deal_events не JOIN-ить напрямую к deals** — создаёт дубли строк; всегда через CTE с GROUP BY deal_id
- **Период включительно**: если хочешь "июнь", то `>= '2026-06-01' AND < '2026-07-01'`

---

## 8. Как подключиться в psql через SSH-туннель

```bash
# Шаг 1: Открой туннель в отдельном терминале
ssh -i C:/Users/junio/.ssh/ssh-key-1777295854643 \
    -L 5433:<SA_PG_HOST>:5432 \
    -N -f junior@62.113.100.67

# Шаг 2: Подключись
psql -h localhost -p 5433 -U <SA_PG_USER> -d postgres

# После входа переключи схему:
SET search_path TO sa;
```

Для YC БД — подключение напрямую (не нужен туннель):
```bash
psql "host=rc1b-o2tqrr9j3gq09svq.mdb.yandexcloud.net \
      port=6432 \
      dbname=system \
      user=JanCloude \
      password=<YC_PG_PASSWORD> \
      sslmode=require"
```
