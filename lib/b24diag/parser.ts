// Парсер диагностического снимка сервера Битрикса (файлы /logs/diag_YYYY-MM-DD_HH-MM-SS.txt,
// выдаются админами td.monolit-crm.ru по SFTP, 16.09.2026). Секции файла:
//   DATE · LOADAVG · TOP PROCESSES CPU/MEM · APACHE SERVER STATUS (AUTO) · APACHE SERVER
//   STATUS (FULL) · ACTIVE HTTP REQUESTS · MYSQL PROCESSLIST · MYSQL INNODB STATUS.
// Никаких серверных импортов — парсер чистый, тестируется на файлах.

export interface HttpRequestRow { seconds: number; client: string | null; method: string; path: string; category: string; own: boolean; cpu: number | null }
export interface SqlRow { id: number; user: string; command: string; seconds: number; state: string; fingerprint: string; info: string; rowsExamined: number }

export interface Snapshot {
  takenAt: string;                  // ISO (МСК из имени файла)
  file: string;
  load1: number | null; load5: number | null; load15: number | null; running: number | null; threads: number | null;
  mysqlCpuPct: number | null; mysqlMemPct: number | null; mysqlRssMb: number | null;
  topCpu: { cmd: string; cpu: number; user: string }[];
  apache: { busy: number | null; idle: number | null; reqPerSec: number | null; durPerReqMs: number | null; bytesPerSec: number | null; totalAccesses: number | null; uptimeSec: number | null; cpuLoad: number | null; restartTime: string | null; slots: number | null };
  working: HttpRequestRow[];        // запросы в работе (M=W) из FULL-статуса, с длительностью
  active: { total: number; own: number; byCategory: Record<string, number>; topPaths: { path: string; n: number; own: boolean }[] };
  mysql: { active: number; long: number; maxSeconds: number; states: Record<string, number>; rows: SqlRow[]; topFingerprints: { fingerprint: string; n: number; maxSeconds: number }[] };
  innodb: { historyListLength: number | null; lockWaits: number; deadlockAt: string | null; deadlockText: string | null; bufferPoolPages: number | null; freeBuffers: number | null; pendingReads: number | null };
  rawSize: number;
}

/** Наш прод (Монолитика) — его запросы к Битриксу считаем «своими». */
export const OWN_IPS = new Set(['62.113.100.67']);
export const LONG_QUERY_SEC = 5;

export function takenAtFromFile(file: string): string | null {
  const m = file.match(/diag_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00` : null;
}

function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^===== (.+?) =====$/gm;
  let m: RegExpExecArray | null; let last: { name: string; start: number } | null = null;
  while ((m = re.exec(text))) {
    if (last) out.set(last.name, text.slice(last.start, m.index));
    last = { name: m[1], start: m.index + m[0].length };
  }
  if (last) out.set(last.name, text.slice(last.start));
  return out;
}

const num = (s: string | undefined | null): number | null => { if (s === undefined || s === null) return null; const v = Number(String(s).replace(',', '.')); return Number.isFinite(v) ? v : null; };

export function categorize(path: string): string {
  if (/^\/rest\/(\d+\/[a-z0-9]+\/)?mlt\./.test(path)) return 'rest_mlt';
  if (path.startsWith('/rest/im.') || path.startsWith('/rest/pull.') || path.includes('/rest/1/') && path.includes('im.')) return 'rest_im';
  if (path.startsWith('/rest/')) return 'rest';
  if (path.startsWith('/crm/mlt')) return 'crm_mlt';
  if (path.startsWith('/crm/')) return 'crm';
  if (path.startsWith('/bitrix/tools/') || path.startsWith('/bitrix/services/') || path.startsWith('/bitrix/components/')) return 'ajax';
  if (path.startsWith('/online/') || path.startsWith('/desktop_app/') || path.startsWith('/pub/')) return 'im';
  if (path.startsWith('/server-status')) return 'monitoring';
  return 'other';
}
export const CATEGORY_LABEL: Record<string, string> = {
  rest_mlt: 'REST mlt.* (наши методы)', rest: 'REST API', rest_im: 'REST мессенджер', crm_mlt: 'CRM /crm/mlt* (наши страницы)', crm: 'CRM интерфейс', ajax: 'AJAX Битрикса', im: 'Мессенджер', monitoring: 'Мониторинг', other: 'Прочее',
};

/** Путь без query и с обезличенными id/токенами вебхуков. */
export function normalizePath(raw: string): string {
  let p = raw.split('?')[0];
  p = p.replace(/^\/rest\/\d+\/[a-z0-9]+\//, '/rest/*/*/');
  p = p.replace(/\/\d{3,}(?=\/|$)/g, '/*');
  return p;
}

export function sqlFingerprint(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/'(?:[^'\\]|\\.)*'/g, '?').replace(/\b\d+\b/g, '?').replace(/IN \((\?,? ?)+\)/gi, 'IN (?)').trim().slice(0, 240);
}

export function parseSnapshot(file: string, text: string): Snapshot {
  const sec = sections(text);
  const takenAt = takenAtFromFile(file) ?? new Date().toISOString();

  // LOADAVG: "13.96 17.65 8.17 2/682 231705"
  const la = (sec.get('LOADAVG') ?? '').trim().split(/\s+/);
  const rt = (la[3] ?? '').split('/');

  // TOP: первая таблица (по CPU)
  const top = sec.get('TOP PROCESSES CPU/MEM') ?? '';
  const topLines = top.split('\n').filter(l => /^\S+\s+\d+\s+[\d.]+\s+[\d.]+/.test(l));
  const firstBlock: typeof topLines = []; const seen = new Set<string>();
  for (const l of topLines) { const pid = l.trim().split(/\s+/)[1]; if (seen.has(pid)) break; seen.add(pid); firstBlock.push(l); }
  const mysqlLine = topLines.find(l => l.includes('mysqld'));
  const mf = mysqlLine ? mysqlLine.trim().split(/\s+/) : null;
  const topCpu = firstBlock.slice(0, 5).map(l => { const f = l.trim().split(/\s+/); return { user: f[0], cpu: Number(f[2]), cmd: f.slice(10).join(' ').slice(0, 60) }; });

  // APACHE AUTO
  const auto = sec.get('APACHE SERVER STATUS (AUTO)') ?? '';
  const kv = new Map<string, string>();
  for (const l of auto.split('\n')) { const m = l.match(/^([A-Za-z ]+):\s*(.+)$/); if (m) kv.set(m[1].trim(), m[2].trim()); }
  const scoreboard = kv.get('Scoreboard') ?? '';

  // APACHE FULL: строки запросов. Формат: "Srv PID Acc M CPU SS Req Dur Conn Child Slot Client" + 1–2 строки протокол/vhost/запрос.
  const full = sec.get('APACHE SERVER STATUS (FULL)') ?? '';
  const working: HttpRequestRow[] = [];
  const fl = full.split('\n');
  for (let i = 0; i < fl.length; i++) {
    const m = fl[i].match(/^\s*(\d+-\d+)\s+(\d+)\s+(\S+)\s+([_SRWKDCLGI.])\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(\S*)$/);
    if (!m) continue;
    const mode = m[4]; if (mode !== 'W') continue;
    const seconds = Number(m[6]); const client = m[12] && /^\d+\.\d+\.\d+\.\d+$/.test(m[12]) ? m[12] : null;
    let tail = ''; for (let j = 1; j <= 3 && i + j < fl.length && !/^\s*\d+-\d+\s+\d+\s/.test(fl[i + j]); j++) tail += ' ' + fl[i + j].trim();
    const rm = tail.match(/\b(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s+(\S+)/);
    if (!rm) continue;
    const path = normalizePath(rm[2]);
    if (path.startsWith('/server-status')) continue;
    working.push({ seconds, client, method: rm[1], path, category: categorize(path), own: !!client && OWN_IPS.has(client), cpu: Number(m[5]) });
  }
  working.sort((a, b) => b.seconds - a.seconds);

  // ACTIVE HTTP REQUESTS (список без длительностей)
  const act = sec.get('ACTIVE HTTP REQUESTS') ?? '';
  const byCategory: Record<string, number> = {}; const pathCount = new Map<string, { n: number; own: boolean }>();
  let total = 0, own = 0;
  for (const l of act.split('\n')) {
    const rm = l.match(/\b(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s+(\S+)/); if (!rm) continue;
    const path = normalizePath(rm[2]); if (path.startsWith('/server-status')) continue;
    const ip = l.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1]; const isOwn = !!ip && OWN_IPS.has(ip) || path.includes('/mlt.');
    total++; if (isOwn) own++;
    const c = categorize(path); byCategory[c] = (byCategory[c] ?? 0) + 1;
    const e = pathCount.get(path) ?? pathCount.set(path, { n: 0, own: isOwn }).get(path)!; e.n++; e.own = e.own || isOwn;
  }
  const topPaths = [...pathCount.entries()].map(([path, v]) => ({ path, n: v.n, own: v.own })).sort((a, b) => b.n - a.n).slice(0, 25);

  // MYSQL PROCESSLIST: блоки "*** N. row ***"
  const pl = sec.get('MYSQL PROCESSLIST') ?? '';
  const rows: SqlRow[] = []; const states: Record<string, number> = {};
  for (const block of pl.split(/\*{3,} \d+\. row \*{3,}/).slice(1)) {
    const get = (k: string) => block.match(new RegExp(`^\\s*${k}:\\s?(.*)$`, 'm'))?.[1]?.trim() ?? '';
    const command = get('Command'); if (command === 'Sleep' || command === 'Daemon' || command === 'Binlog Dump') continue;
    const infoM = block.match(/\n\s*Info:\s?([\s\S]*?)\n\s*Time_ms:/); const info = (infoM?.[1] ?? '').trim();
    if (!info || /^SHOW FULL PROCESSLIST/i.test(info) || info === 'NULL') continue;
    const seconds = num(get('Time')) ?? 0; const state = get('State') || '—';
    states[state] = (states[state] ?? 0) + 1;
    rows.push({ id: num(get('Id')) ?? 0, user: get('User'), command, seconds, state, fingerprint: sqlFingerprint(info), info: info.replace(/\s+/g, ' ').slice(0, 600), rowsExamined: num(get('Rows_examined')) ?? 0 });
  }
  rows.sort((a, b) => b.seconds - a.seconds);
  const fp = new Map<string, { n: number; maxSeconds: number }>();
  for (const r of rows) { const e = fp.get(r.fingerprint) ?? fp.set(r.fingerprint, { n: 0, maxSeconds: 0 }).get(r.fingerprint)!; e.n++; e.maxSeconds = Math.max(e.maxSeconds, r.seconds); }
  const topFingerprints = [...fp.entries()].map(([fingerprint, v]) => ({ fingerprint, ...v })).sort((a, b) => b.n - a.n || b.maxSeconds - a.maxSeconds).slice(0, 15);

  // INNODB
  const inn = sec.get('MYSQL INNODB STATUS') ?? '';
  const dl = inn.match(/LATEST DETECTED DEADLOCK\s*-+\s*\n([\s\S]*?)\n-{5,}\n(?:TRANSACTIONS|FILE I\/O)/);
  const dlDate = dl?.[1].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/m)?.[1] ?? null;

  return {
    takenAt, file,
    load1: num(la[0]), load5: num(la[1]), load15: num(la[2]), running: num(rt[0]), threads: num(rt[1]),
    mysqlCpuPct: mf ? num(mf[2]) : null, mysqlMemPct: mf ? num(mf[3]) : null, mysqlRssMb: mf ? Math.round((num(mf[5]) ?? 0) / 1024) : null,
    topCpu,
    apache: {
      busy: num(kv.get('BusyWorkers')), idle: num(kv.get('IdleWorkers')), reqPerSec: num(kv.get('ReqPerSec')), durPerReqMs: num(kv.get('DurationPerReq')),
      bytesPerSec: num(kv.get('BytesPerSec')), totalAccesses: num(kv.get('Total Accesses')), uptimeSec: num(kv.get('ServerUptimeSeconds')), cpuLoad: num(kv.get('CPULoad')),
      restartTime: kv.get('RestartTime') ?? null, slots: scoreboard.length || null,
    },
    working,
    active: { total, own, byCategory, topPaths },
    mysql: { active: rows.length, long: rows.filter(r => r.seconds >= LONG_QUERY_SEC).length, maxSeconds: rows[0]?.seconds ?? 0, states, rows: rows.slice(0, 40), topFingerprints },
    innodb: {
      historyListLength: num(inn.match(/History list length (\d+)/)?.[1]),
      lockWaits: (inn.match(/LOCK WAIT/g) ?? []).length,
      deadlockAt: dlDate, deadlockText: dl ? dl[1].slice(0, 3000) : null,
      bufferPoolPages: num(inn.match(/Buffer pool size\s+(\d+)/)?.[1]), freeBuffers: num(inn.match(/Free buffers\s+(\d+)/)?.[1]), pendingReads: num(inn.match(/Pending reads\s+(\d+)/)?.[1]),
    },
    rawSize: text.length,
  };
}

// ── Тяжесть снимка по порогам (настройки b24_diag_settings) ────────────────────
export interface Thresholds { load1Warn: number; load1Crit: number; busyWarn: number; busyCrit: number; longWarn: number; longCrit: number; maxSecWarn: number; maxSecCrit: number; lockWarn: number; lockCrit: number; mysqlCpuWarn: number; mysqlCpuCrit: number }
export const DEFAULT_THRESHOLDS: Thresholds = { load1Warn: 8, load1Crit: 16, busyWarn: 40, busyCrit: 80, longWarn: 3, longCrit: 10, maxSecWarn: 30, maxSecCrit: 120, lockWarn: 1, lockCrit: 5, mysqlCpuWarn: 200, mysqlCpuCrit: 400 };

export interface Severity { level: 0 | 1 | 2; flags: { key: string; label: string; value: number; level: 1 | 2 }[] }

export function severityOf(s: Snapshot, t: Thresholds): Severity {
  const flags: Severity['flags'] = [];
  const chk = (key: string, label: string, v: number | null, warn: number, crit: number) => {
    if (v === null) return; if (v >= crit) flags.push({ key, label, value: v, level: 2 }); else if (v >= warn) flags.push({ key, label, value: v, level: 1 });
  };
  chk('load1', 'load average (1 мин)', s.load1, t.load1Warn, t.load1Crit);
  chk('busy', 'занятых воркеров Apache', s.apache.busy, t.busyWarn, t.busyCrit);
  chk('long', `запросов MySQL дольше ${LONG_QUERY_SEC} с`, s.mysql.long, t.longWarn, t.longCrit);
  chk('maxsec', 'самый долгий запрос MySQL, с', s.mysql.maxSeconds, t.maxSecWarn, t.maxSecCrit);
  chk('locks', 'транзакций в ожидании блокировки', s.innodb.lockWaits, t.lockWarn, t.lockCrit);
  chk('mysqlcpu', 'CPU процесса MySQL, %', s.mysqlCpuPct, t.mysqlCpuWarn, t.mysqlCpuCrit);
  const level = flags.some(f => f.level === 2) ? 2 : flags.length ? 1 : 0;
  return { level, flags };
}
