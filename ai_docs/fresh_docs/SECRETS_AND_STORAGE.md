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
- Это self-hosted **Supabase** на `62.113.100.67`, доступ через пулер **Supavisor**
  напрямую (туннель НЕ нужен). Локальный `.env.local`:
  ```
  SA_PG_HOST=62.113.100.67
  SA_PG_PORT=5432                       # 5432 = session pooler, 6543 = transaction
  SA_PG_USER=junior_user.your-tenant-id # СУФФИКС ТЕНАНТА ОБЯЗАТЕЛЕН
  SA_PG_PASSWORD=<read-only, см. ниже>
  ```
- ⚠️ **`your-tenant-id` — НЕ плейсхолдер**, а дефолтный `POOLER_TENANT_ID` Supabase
  (не меняли). Без суффикса Supavisor отвечает `Tenant or user not found`.
- Юзер `junior_user` — READ-ONLY (public, bot, jivo, sa, sd, ut, va). db `postgres`, ssl off.
- **На сервере `SA_PG_*` НЕ заданы** → прод `analyticsDb()` фолбэчит на YC `analytics`.
  То есть локально сделки из Supabase, на проде — из YC analytics (разные источники).
- Пароль read-only юзера — в `mishas.txt` (передан владельцем) / в локальном `.env.local`.

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
```
⚠️ **Экранирование `$` в `YC_PG_PASSWORD`:** `@next/env` гонит значения через `dotenv-expand`,
и `$` трактуется как подстановка переменной → пароль приходит битым. Каждый `$` писать как `\$`.
Источник правды по паролю — Yandex Lockbox (секрет `connection-a59g5sotla4kmcv1mhbj`,
ключ `postgresql_password`, длина 36). Проверка после правки:
```bash
node -e 'require("@next/env").loadEnvConfig(process.cwd()); console.log(JSON.stringify(process.env.YC_PG_PASSWORD))'
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
