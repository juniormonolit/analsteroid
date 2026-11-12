#!/usr/bin/env python3
r"""Копия свежих данных из Roan (восстановленная база Миши/Сергея) в нашу БД monolitika.

Зачем (12.11.2026): после смерти 62 звонки (va.*) и задачи Битрикса пишутся только на Roan,
у нас va.calls оборван на 08.10, расшифровок/оценок/задач нет вовсе. Roan даёт только REST
на чтение (PostgREST, GET, 1000 строк за ответ, 300 запросов/мин с IP прода), поэтому всё
приложение читает НАШИ таблицы, а этот скрипт по таймеру доливает их из Roan.

sa.deals/departments/stages НЕ копируем: на Roan они заморожены на 31.10, у нас — живые от n8n.

Схему не трогаем (условие Арнольда по va.calls): берём только общие колонки. Ключи (id) на
Roan и у нас совпадают (проверено 12.11), поэтому догрузка идемпотентна — ON CONFLICT.

Формат — JSON, не CSV: CSV PostgREST удваивает обратную косую черту, и `\"` внутри jsonb/массивов
ломал загрузку (а в тексте молча удваивался) — проба 12.11. JSON грузим одной строкой через \copy
в CSV-режиме с непечатными QUOTE/DELIMITER (так \copy не трогает «\»), дальше jsonb_populate_recordset.

Пагинация — по (колонка_времени, ключ) от максимума этой колонки в НАШЕЙ таблице: перезапуск
продолжает с места, повторная строка просто перезапишется. Запуск: monolitika-roan-sync.timer.
Env (из ~/analsteroid/secrets.env): ROAN_REST_URL, ROAN_REST_KEY, SA_PG_*.
"""
import json, os, subprocess, sys, tempfile, time, urllib.parse, urllib.request

PAGE = 1000            # Roan больше не отдаёт
PAUSE = 0.25           # ≤ 240 запросов/мин при лимите 300
MAX_PAGES = int(os.environ.get('ROAN_SYNC_MAX_PAGES', '400'))  # на таблицу за прогон; остаток — следующим

CALL_COLS = ('id bitrix_call_id bitrix_activity_id deal_id contact_id company_id manager_id phone_number direction '
             'duration_seconds called_at recording_file_id status result error_message failed_at_stage retry_count '
             'stage_at_call_time stage_at_day_start transcribed_at transcription_provider analyzed_at created_at updated_at').split()
TASK_COLS = ('task_id group_id status status_view title responsible_id responsible_name created_at changed_at closed_at '
             'deal_id is_deleted src_id updated_at deadline_at created_by closed_by priority description auditors '
             'accomplices tags flow_id stage_id date_start task_control').split()

def upd(cols, key):
    return ', '.join(f'{c} = excluded.{c}' for c in cols if c != key)

TABLES = [
    # (имя, endpoint Roan, наша таблица, колонки, колонка времени, ключ, SQL-хвост вставки)
    ('calls', 'calls', 'va.calls', CALL_COLS, 'updated_at', 'id',
     # уникален и bitrix_call_id: строку с тем же звонком под другим id не трогаем, а не роняем прогон
     'WHERE NOT EXISTS (SELECT 1 FROM va.calls c WHERE c.bitrix_call_id = s.bitrix_call_id AND c.id <> s.id) '
     f'ON CONFLICT (id) DO UPDATE SET {upd(CALL_COLS, "id")}'),
    ('transcriptions', 'transcriptions', 'va.transcriptions',
     'id call_id provider raw_text formatted_dialogue created_at'.split(), 'created_at', 'id',
     'ON CONFLICT (id) DO NOTHING'),
    ('evaluations', 'evaluations', 'va.evaluations',
     'id call_id deal_id funnel_type model_used prompt_version overall_score goals_results ai_summary recommendation created_at'.split(),
     'created_at', 'id', 'ON CONFLICT (id) DO NOTHING'),
    ('task_payload', 'bitrix_task_payload_raw', 'sa.bitrix_task_payload_raw',
     'id received_at event task_id deal_id payload'.split(), 'id', None, 'ON CONFLICT (id) DO NOTHING'),
    # results/results_checked_at/last_reconcile_at/src_event — только наши, их не перезаписываем
    ('tasks', 'bitrix_task_v', 'sa.bitrix_task_current', TASK_COLS, 'updated_at', 'task_id',
     f'ON CONFLICT (task_id) DO UPDATE SET {upd(TASK_COLS, "task_id")}'),
]

BASE = os.environ['ROAN_REST_URL'].rstrip('/')
KEY = os.environ['ROAN_REST_KEY']
PSQL = ['psql', '-h', os.environ['SA_PG_HOST'], '-p', os.environ.get('SA_PG_PORT', '6432'),
        '-U', os.environ['SA_PG_USER'], '-d', os.environ['SA_PG_DB'], '-XAtq', '-v', 'ON_ERROR_STOP=1']
PGENV = {**os.environ, 'PGPASSWORD': os.environ['SA_PG_PASSWORD'], 'PGSSLMODE': 'require'}

def psql(*cmds):
    args = list(PSQL)
    for c in cmds:
        args += ['-c', c]
    return subprocess.run(args, env=PGENV, check=True, capture_output=True, text=True).stdout.strip()

def fetch(endpoint, params):
    url = f'{BASE}/{endpoint}?{urllib.parse.urlencode(params, safe=",()")}'
    req = urllib.request.Request(url, headers={'apikey': KEY, 'Accept': 'application/json'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # сеть/5xx/429 — пауза и повтор
            if attempt == 2:
                raise
            print(f'[roan-sync] {endpoint}: {e} — повтор', file=sys.stderr)
            time.sleep(5 * (attempt + 1))

def last_row(rows, tcol, kcol):
    """Значения (время, ключ) последней строки — для следующей страницы."""
    if not rows:
        return 0, None, None
    last = rows[-1]
    return len(rows), str(last[tcol]), (str(last[kcol]) if kcol else None)

def q(v):
    return '"' + v.replace('"', '\\"') + '"'

def sync(name, endpoint, table, cols, tcol, kcol, tail):
    wm = psql(f'SELECT max({tcol})::text FROM {table}') or None
    key = None
    total = pages = 0
    t0 = time.time()
    while pages < MAX_PAGES:
        params = {'select': ','.join(cols), 'limit': PAGE,
                  'order': f'{tcol}.asc' + (f',{kcol}.asc' if kcol else '')}
        if wm is not None and key is not None:
            params['or'] = f'({tcol}.gt.{q(wm)},and({tcol}.eq.{q(wm)},{kcol}.gt.{q(key)}))'
        elif wm is not None:
            # первый шаг — с максимума у нас включительно (дубли — ON CONFLICT); без ключа дальше строго «больше»
            params[tcol] = f'{"gt" if pages and not kcol else "gte"}.{wm}'
        rows = json.loads(fetch(endpoint, params))
        n, new_wm, new_key = last_row(rows, tcol, kcol)
        if n == 0:
            break
        with tempfile.NamedTemporaryFile('w', suffix='.json', encoding='utf-8') as f:
            f.write(json.dumps(rows, ensure_ascii=False)); f.flush()   # одна строка: переводы строк экранированы
            collist = ', '.join(cols)
            psql('BEGIN',
                 'CREATE TEMP TABLE j (doc jsonb) ON COMMIT DROP',
                 f"\\copy j (doc) FROM '{f.name}' WITH (FORMAT csv, QUOTE e'\\x01', DELIMITER e'\\x02')",
                 f'INSERT INTO {table} ({collist}) SELECT {collist} '
                 f'FROM jsonb_populate_recordset(NULL::{table}, (SELECT doc FROM j)) s {tail}',
                 'COMMIT')
        total += n; pages += 1
        if not kcol and new_wm == wm:
            break
        wm, key = new_wm, new_key
        if n < PAGE:
            break
        time.sleep(PAUSE)
    print(f'[roan-sync] {name}: {total} строк, {pages} стр., {time.time() - t0:.0f} с, до {wm}')

def main():
    only = set(sys.argv[1:])
    failed = False
    for spec in TABLES:
        if only and spec[0] not in only:
            continue
        try:
            sync(*spec)
        except subprocess.CalledProcessError as e:
            failed = True
            print(f'[roan-sync] {spec[0]}: ошибка БД: {e.stderr.strip()[:500]}', file=sys.stderr)
        except Exception as e:
            failed = True
            print(f'[roan-sync] {spec[0]}: {e}', file=sys.stderr)
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
