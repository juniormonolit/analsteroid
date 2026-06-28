# Доступы, ключи и где что хранится

> ⚠️ Этот файл коммитится в git — **здесь нет самих секретов**, только где они лежат и как ими ходить.
> Реальные значения — в `.env.local` и `certs/` (оба в `.gitignore`), их переносим вручную (см. ниже).

---

## 1. Сервер (прод)

| Параметр | Значение |
|----------|----------|
| Хост | `62.113.100.67` |
| Пользователь | `junior` (работаем только под ним; `danny` — запрещён) |
| SSH-ключ | `~/.ssh/ssh-key-1777295854643` (и `.pub` рядом) |
| Каталог проекта | `/home/junior/analsteroid` |
| Порт приложения | `8100` |
| Запуск | standalone Node, `start.sh` на сервере, рестарт делает `deploy.sh` |

SSH:
```bash
ssh -i ~/.ssh/ssh-key-1777295854643 junior@62.113.100.67
```

---

## 2. Базы данных — куда ходим

### YC PostgreSQL (system + analytics)
- Хост: `rc1b-o2tqrr9j3gq09svq.mdb.yandexcloud.net`, порт `6432`
- Юзер: `JanCloude`, пароль: **`YC_PG_PASSWORD` из `.env.local`**
- SSL: да, CA — `certs/yandex-ca.pem`
- БД `system` → `systemDb()`; БД `analytics` → `ycAnalyticsDb()`
- Подключение прямое (туннель не нужен).

### БД Миши (сделки, схема `sa`) → `analyticsDb()`
- На сервере — через env `SA_PG_HOST/PORT/USER/PASSWORD` (в серверном `.env.local`).
- Локально — через SSH-туннель к серверу, затем подключение на localhost. Пример:
  ```bash
  ssh -i ~/.ssh/ssh-key-1777295854643 -L 5433:<SA_PG_HOST>:5432 -N junior@62.113.100.67
  psql -h localhost -p 5433 -U <SA_PG_USER> -d postgres
  SET search_path TO sa;
  ```
- **Без SA-туннеля/env локальный `next dev` не покажет сделки** — фолбэк уходит на YC analytics. Реальное тестирование — на сервере (`bash deploy.sh`).

### Где взять реальные значения
```bash
ssh -i ~/.ssh/ssh-key-1777295854643 junior@62.113.100.67 "cat /home/junior/analsteroid/.env.local"
```
Там лежат и YC-пароль, и `SA_PG_*`.

---

## 3. Локальные секреты (НЕ в git — перенести вручную на Mac)

| Файл | Что | Откуда взять |
|------|-----|--------------|
| `analsteroid/.env.local` | env для локального dev (YC creds, пути) | скопировать со старой машины или с сервера |
| `analsteroid/certs/yandex-ca.pem` | CA-сертификат YC | скопировать со старой машины или с сервера (`/home/junior/analsteroid/certs/`) |
| `~/.ssh/ssh-key-1777295854643` (+`.pub`) | SSH-ключ к серверу | скопировать `~/.ssh/` со старой машины |

Текущий локальный `.env.local` (структура; пароли подставить):
```
YC_PG_HOST=rc1b-o2tqrr9j3gq09svq.mdb.yandexcloud.net
YC_PG_PORT=6432
YC_PG_USER=JanCloude
YC_PG_PASSWORD=<секрет>
YC_PG_SSL_CA_PATH=./certs/yandex-ca.pem
YC_ANALYTICS_DB=analytics
YC_SYSTEM_DB=system
PORT=3004
# Для локального доступа к сделкам Миши добавить (опционально, через туннель):
# SA_PG_HOST=127.0.0.1
# SA_PG_PORT=5433
# SA_PG_USER=<секрет>
# SA_PG_PASSWORD=<секрет>
```

---

## 4. Где хранятся данные приложения

| Данные | БД / место |
|--------|-----------|
| Сделки, события, воронки, стадии, товарные группы | БД Миши, схема `sa` |
| Оргструктура, отделы, сотрудники | YC `system` (`org_resolved_hierarchy`, `departments`, `employees`) |
| Сохранённые отчёты (вся конфигурация) | YC `system`.`saved_reports` |
| Планы менеджеров | YC `system`.`manager_plans` (+ `plan_settings`) |
| Рабочий календарь | YC `system`.`working_calendar` |
| Сессии пользователей | YC `system` (user_sessions) |
| Каталог метрик | YC `analytics`.`metrics` |
| Настройки вида (плотность/шрифт) | **localStorage браузера** (ключ `report-view-prefs`) — НЕ в БД |

Пользователи приложения: сейчас только **`admin`** (и технический `junior`). Логинов больше нет.
