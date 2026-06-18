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
