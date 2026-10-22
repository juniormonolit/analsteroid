/**
 * Источник данных Панели снабжения («Ответы на запросы»): таблицы как CSV.
 *
 * SUPPLY_PANEL_SOURCE:
 *   ssh (по умолчанию) — ssh [-i $SUPPLY_PANEL_SSH_KEY -o IdentitiesOnly=yes] -o BatchMode=yes $SUPPLY_PANEL_SSH sql,
 *                        запрос `select * from "<таблица>"` — в stdin; список таблиц — команда `tables`;
 *   sqlite:<путь>      — sqlite3 -csv -header <путь> 'select * from "<таблица>"' (локальное зеркало, для сверки).
 * Процессы запускаются через spawn без shell. Только чтение.
 */
import { spawn } from 'node:child_process';

export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export interface Column { name: string; type: string }

const DEFAULT_HOST = 'monolitika-ro@5.42.106.70';
const TABLE_TIMEOUT_MS = 120_000;
const MAX_OUT = 1024 * 1024 * 1024; // 1 ГБ: самая большая таблица (history) — десятки МБ

/** Таблицы, нужные расчёту (остальные таблицы зеркала не тянем). */
export const NEEDED_TABLES = [
  'history', 'tasks', 'projects', 'denied', 'fetched', 'deals', 'deals_all', 'users', 'supply_users', 'meta',
  'goods', 'deal_products', 'deal_lines', 'cat_sections', 'cat_products', 'cat_offers', 'stages',
] as const;

function run(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (e: Error | null, v?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) reject(e); else resolve(v ?? '');
    };
    const timer = setTimeout(() => { p.kill('SIGKILL'); finish(new Error(`${cmd}: таймаут ${TABLE_TIMEOUT_MS / 1000} с`)); }, TABLE_TIMEOUT_MS);
    p.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUT) { p.kill('SIGKILL'); finish(new Error(`${cmd}: вывод больше ${MAX_OUT} байт`)); return; }
      out.push(b);
    });
    p.stderr.on('data', (b: Buffer) => { if (err.length < 50) err.push(b); });
    p.on('error', e => finish(e));
    p.on('close', code => {
      if (code) finish(new Error(`${cmd} завершился с кодом ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`));
      else finish(null, Buffer.concat(out).toString('utf8'));
    });
    p.stdin.on('error', () => { /* процесс мог завершиться раньше записи */ });
    p.stdin.end(stdin ?? '');
  });
}

/** CSV по RFC 4180: кавычки, удвоенные кавычки, переводы строк внутри полей. Пустое поле → null. */
export function parseCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  const n = text.length;
  let i = 0;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const row: (string | null)[] = [];
    for (;;) {
      let val: string;
      if (text.charCodeAt(i) === 34) { // "
        i++;
        let s = '';
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) { s += text.slice(i); i = n; break; }
          s += text.slice(i, q);
          if (text.charCodeAt(q + 1) === 34) { s += '"'; i = q + 2; } else { i = q + 1; break; }
        }
        val = s;
      } else {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === 44 || c === 10 || c === 13) break;
          j++;
        }
        val = text.slice(i, j);
        i = j;
      }
      row.push(val === '' ? null : val);
      const c = text.charCodeAt(i);
      if (c === 44) { i++; continue; }
      if (c === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      break;
    }
    rows.push(row);
  }
  return rows;
}

function convert(v: string | null, type: string): Cell {
  if (v === null) return null;
  const t = type.toUpperCase();
  if (t.startsWith('INT')) {
    if (/^[+-]?\d+$/.test(v)) return Number(v);
    const x = Number(v);
    return Number.isFinite(x) && Number.isInteger(x) ? x : v;
  }
  if (t.startsWith('REAL') || t.startsWith('FLOAT') || t.startsWith('DOUBLE') || t.startsWith('NUM')) {
    const x = Number(v);
    return Number.isFinite(x) ? x : v;
  }
  return v;
}

export function csvToRows(text: string, cols: Column[]): Row[] {
  const parsed = parseCsv(text);
  const rows: Row[] = [];
  for (let r = 1; r < parsed.length; r++) { // 0 — заголовок
    const line = parsed[r]!;
    const row: Row = {};
    for (let c = 0; c < cols.length; c++) row[cols[c]!.name] = convert(line[c] ?? null, cols[c]!.type);
    rows.push(row);
  }
  return rows;
}

export interface Source {
  /** Столбцы таблиц: {таблица: [{name, type}]}. */
  tables(): Promise<Record<string, Column[]>>;
  /** Все строки таблицы в порядке rowid. */
  table(name: string, cols?: Column[]): Promise<Row[]>;
  describe: string;
}

export function sshArgs(): string[] {
  const key = process.env.SUPPLY_PANEL_SSH_KEY;
  const host = process.env.SUPPLY_PANEL_SSH || DEFAULT_HOST;
  const a: string[] = [];
  if (key) a.push('-i', key, '-o', 'IdentitiesOnly=yes');
  a.push('-o', 'BatchMode=yes', host);
  return a;
}

function sshSource(): Source {
  return {
    describe: 'ssh',
    async tables() {
      // строки вида «name (N): col TYPE, col TYPE»
      const out = await run('ssh', [...sshArgs(), 'tables']);
      const res: Record<string, Column[]> = {};
      for (const line of out.split('\n')) {
        const m = /^(\w+) \((\d+)\): (.*)$/.exec(line.trim());
        if (!m) continue;
        res[m[1]!] = m[3]!.split(', ').map(c => {
          const k = c.indexOf(' ');
          return k < 0 ? { name: c, type: '' } : { name: c.slice(0, k), type: c.slice(k + 1) };
        });
      }
      return res;
    },
    async table(name, cols) {
      const c = cols ?? (await this.tables())[name];
      if (!c) throw new Error(`таблицы ${name} нет в источнике`);
      return csvToRows(await run('ssh', [...sshArgs(), 'sql'], `select * from "${name}"`), c);
    },
  };
}

function sqliteSource(path: string): Source {
  return {
    describe: 'sqlite',
    async tables() {
      const out = await run('sqlite3', ['-csv', path,
        "select m.name, p.name, p.type from sqlite_master m, pragma_table_info(m.name) p where m.type = 'table' order by m.name, p.cid"]);
      const res: Record<string, Column[]> = {};
      for (const r of parseCsv(out)) (res[r[0]!] ??= []).push({ name: r[1] ?? '', type: r[2] ?? '' });
      return res;
    },
    async table(name, cols) {
      const c = cols ?? (await this.tables())[name];
      if (!c) throw new Error(`таблицы ${name} нет в источнике`);
      return csvToRows(await run('sqlite3', ['-csv', '-header', path, `select * from "${name}"`]), c);
    },
  };
}

export function openSource(spec: string | undefined = process.env.SUPPLY_PANEL_SOURCE): Source {
  const s = (spec || 'ssh').trim();
  if (s === 'ssh') return sshSource();
  if (s.startsWith('sqlite:')) return sqliteSource(s.slice('sqlite:'.length));
  throw new Error(`SUPPLY_PANEL_SOURCE: ожидается ssh или sqlite:<путь>, получено ${s.slice(0, 20)}`);
}

export type Tables = Record<(typeof NEEDED_TABLES)[number], Row[]>;

/** Тянет нужные расчёту таблицы (последовательно: ssh-канал один, нагрузку на сервер не множим). */
export async function loadTables(src: Source = openSource()): Promise<Tables> {
  const cols = await src.tables();
  const res = {} as Tables;
  for (const t of NEEDED_TABLES) {
    const c = cols[t];
    if (!c) throw new Error(`в источнике нет таблицы ${t}`);
    res[t] = await src.table(t, c);
  }
  return res;
}
