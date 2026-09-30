# analsteroid

BI-аналитика на стероидах — дашборды, отчёты по сделкам, воронки продаж.

## Stack

- Next.js 16 (App Router, standalone)
- Yandex Cloud PostgreSQL (`analytics` DB)
- Данные поступают через Bitrix outgoing webhooks — Bitrix никогда не опрашивается из отчётов напрямую

## Связанные сервисы

- [system](https://github.com/juniormonolit/system) — синхронизация орг-структуры и сотрудников

## Deploy

VM `103.76.52.220`, systemd + Caddy, порт `3004`.

## Переменные окружения безопасности (#8256)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `BITRIX_EVENTS_APP_TOKEN` | — (обязательна) | `auth[application_token]` из событий Битрикса для `/api/bitrix/events`. Не задана — все события отклоняются 403 (fail-closed). |
| `BITRIX_PORTAL_DOMAIN` | `td.monolit-crm.ru` | Домен портала, от которого принимаются события. |
| `LOGIN_RATE_WINDOW_SEC` | `900` | Окно лимита неудачных входов, секунд. |
| `LOGIN_RATE_MAX_PER_LOGIN` | `10` | Неудачных попыток на логин за окно, дальше 429. |
| `LOGIN_RATE_MAX_PER_IP` | `50` | Неудачных попыток с одного IP за окно (офис за одним NAT), дальше 429. |
| `TRUSTED_PROXY_HOPS` | `1` | Сколько доверенных прокси (Caddy) дописывают адрес в `X-Forwarded-For`; IP клиента — N-й адрес справа. |
| `REDIS_URL` | — | Если задан — счётчики лимита входа в Redis (общие, переживают рестарт); иначе память процесса. |

Порт приложения должен слушать только `127.0.0.1` (снаружи — только через Caddy), иначе `X-Forwarded-For` подделывается.

Тесты безопасности: `NODE_OPTIONS=--experimental-strip-types npm run test:security`.
Перед выкатом правок метрик — `scripts/check-metric-definitions.ts` (только чтение) с окружением сервиса.
