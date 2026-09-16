// Синхронизация логов Битрикса: новые файлы из /logs → parseSnapshot → b24_diag_snapshots;
// после — оценка свежего снимка и оповещение через бота «Аналитик» (функция
// b24_diag_alerts, выключена по умолчанию, как все). Раз в 5 мин из instrumentation.ts и
// кнопкой из настроек.
import { systemDb } from '@/lib/db/clients';
import { sendBitrixBotMessage, getBotFunctionConfig, channelEnabled } from '@/lib/bitrix/notify';
import { listRemote, downloadRemote, keyExists, keyPath } from './sftp';
import { parseSnapshot, severityOf, DEFAULT_THRESHOLDS, type Thresholds, type Snapshot } from './parser';

export interface B24Settings extends Thresholds { enabled: boolean; alertLevel: number; alertCooldownMin: number; alertMaxAgeMin: number }

const KEYS: Record<string, keyof B24Settings> = {
  enabled: 'enabled', load1_warn: 'load1Warn', load1_crit: 'load1Crit', busy_warn: 'busyWarn', busy_crit: 'busyCrit', long_warn: 'longWarn', long_crit: 'longCrit',
  maxsec_warn: 'maxSecWarn', maxsec_crit: 'maxSecCrit', lock_warn: 'lockWarn', lock_crit: 'lockCrit', mysqlcpu_warn: 'mysqlCpuWarn', mysqlcpu_crit: 'mysqlCpuCrit',
  alert_level: 'alertLevel', alert_cooldown_min: 'alertCooldownMin', alert_max_age_min: 'alertMaxAgeMin',
};

export async function loadB24Settings(): Promise<B24Settings> {
  const s: B24Settings = { ...DEFAULT_THRESHOLDS, enabled: true, alertLevel: 2, alertCooldownMin: 60, alertMaxAgeMin: 20 };
  const r = await systemDb().query<{ key: string; value: unknown }>(`SELECT key, value FROM b24_diag_settings`);
  for (const row of r.rows) { const k = KEYS[row.key]; if (!k) continue; (s as unknown as Record<string, unknown>)[k] = k === 'enabled' ? Boolean(row.value) : Number(row.value); }
  return s;
}

export interface SyncResult { listed: number; downloaded: number; inserted: number; skipped: number; errors: string[]; alert: string | null; ms: number }

let _running = false;

export async function syncB24Diag(opts: { force?: boolean; limit?: number } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const res: SyncResult = { listed: 0, downloaded: 0, inserted: 0, skipped: 0, errors: [], alert: null, ms: 0 };
  if (_running) { res.errors.push('синхронизация уже идёт'); return res; }
  _running = true;
  try {
    const s = await loadB24Settings();
    if (!s.enabled && !opts.force) { res.errors.push('синхронизация выключена в настройках'); return res; }
    if (!(await keyExists())) { res.errors.push(`нет SSH-ключа: ${keyPath()}`); return res; }
    const db = systemDb();
    const remote = await listRemote();
    res.listed = remote.length;
    const have = new Set((await db.query<{ file: string }>(`SELECT file FROM b24_diag_snapshots`)).rows.map(r => r.file));
    const missing = remote.filter(f => !have.has(f.name)).map(f => f.name).slice(-(opts.limit ?? 60));
    if (missing.length) {
      const texts = await downloadRemote(missing);
      res.downloaded = texts.size;
      for (const [file, text] of texts) {
        try {
          const snap = parseSnapshot(file, text);
          const sev = severityOf(snap, s);
          await db.query(
            `INSERT INTO b24_diag_snapshots (file, taken_at, load1, load5, load15, running, threads, mysql_cpu_pct, mysql_mem_pct, mysql_rss_mb,
               apache_busy, apache_idle, apache_slots, req_per_sec, dur_per_req_ms, bytes_per_sec, apache_restart,
               http_active, http_own, http_working, http_working_max_sec, mysql_active, mysql_long, mysql_max_sec, innodb_history, lock_waits, deadlock_at,
               severity, flags, detail, raw_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
             ON CONFLICT (file) DO NOTHING`,
            [file, snap.takenAt, snap.load1, snap.load5, snap.load15, snap.running, snap.threads, snap.mysqlCpuPct, snap.mysqlMemPct, snap.mysqlRssMb,
             snap.apache.busy, snap.apache.idle, snap.apache.slots, snap.apache.reqPerSec, snap.apache.durPerReqMs, snap.apache.bytesPerSec, snap.apache.restartTime,
             snap.active.total, snap.active.own, snap.working.length, snap.working[0]?.seconds ?? 0, snap.mysql.active, snap.mysql.long, snap.mysql.maxSeconds,
             snap.innodb.historyListLength, snap.innodb.lockWaits, snap.innodb.deadlockAt,
             sev.level, JSON.stringify(sev.flags),
             JSON.stringify({ topCpu: snap.topCpu, working: snap.working.slice(0, 60), active: snap.active, mysql: { states: snap.mysql.states, rows: snap.mysql.rows, topFingerprints: snap.mysql.topFingerprints }, innodb: snap.innodb, apache: snap.apache }),
             snap.rawSize]);
          res.inserted++;
        } catch (e) { res.errors.push(`${file}: ${e instanceof Error ? e.message : e}`); }
      }
    }
    res.skipped = remote.length - missing.length;
    try { res.alert = await maybeAlert(s); } catch (e) { res.errors.push(`оповещение: ${e instanceof Error ? e.message : e}`); }
  } catch (e) {
    res.errors.push(e instanceof Error ? e.message : String(e));
  } finally { _running = false; res.ms = Date.now() - t0; }
  return res;
}

// ── Оповещение ────────────────────────────────────────────────────────────────
const fmtN = (v: number | string | null) => (v === null ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 }));

async function maybeAlert(s: B24Settings): Promise<string | null> {
  const db = systemDb();
  const last = (await db.query<{ id: string; taken_at: Date; severity: number; flags: { label: string; value: number; level: number }[]; load1: string | null; apache_busy: number | null; apache_slots: number | null; mysql_long: number | null; mysql_max_sec: number | null; lock_waits: number | null; http_own: number | null; http_active: number | null; alerted_at: Date | null; detail: { mysql?: { topFingerprints?: { fingerprint: string; n: number; maxSeconds: number }[] }; working?: { seconds: number; method: string; path: string; own: boolean }[] } }>(
    `SELECT id::text, taken_at, severity, flags, load1, apache_busy, apache_slots, mysql_long, mysql_max_sec, lock_waits, http_own, http_active, alerted_at, detail
       FROM b24_diag_snapshots ORDER BY taken_at DESC LIMIT 1`)).rows[0];
  if (!last) return null;
  const ageMin = (Date.now() - new Date(last.taken_at).getTime()) / 60000;
  const lastAlert = (await db.query<{ at: Date | null; sev: number | null }>(`SELECT max(alerted_at) AS at, (SELECT severity FROM b24_diag_snapshots WHERE alerted_at IS NOT NULL ORDER BY alerted_at DESC LIMIT 1) AS sev FROM b24_diag_snapshots`)).rows[0];
  const sinceAlertMin = lastAlert?.at ? (Date.now() - new Date(lastAlert.at).getTime()) / 60000 : Infinity;

  const enabled = await channelEnabled('b24_diag_alerts');
  const cfg = await getBotFunctionConfig('b24_diag_alerts');
  const recipients = (cfg.recipients ?? []).filter(Boolean);
  const send = async (text: string) => { for (const r of recipients) await sendBitrixBotMessage(String(r), text, undefined, 'b24_diag_alerts'); };

  // Снятие тревоги: последний снимок в норме, а прошлое оповещение было тревожным и снятие ещё не слали.
  if (last.severity < s.alertLevel && lastAlert?.sev !== null && lastAlert?.sev !== undefined && lastAlert.sev >= s.alertLevel && last.alerted_at === null && ageMin <= s.alertMaxAgeMin * 3) {
    const text = `✅ Битрикс: нагрузка в норме. Снимок ${new Date(last.taken_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })}: load ${fmtN(last.load1)}, воркеров ${last.apache_busy ?? '—'}/${last.apache_slots ?? '—'}, долгих SQL ${last.mysql_long ?? 0}.`;
    await db.query(`UPDATE b24_diag_snapshots SET alerted_at = now() WHERE id = $1`, [last.id]);
    if (enabled && recipients.length) await send(text);
    return `снятие тревоги${enabled && recipients.length ? '' : ' (функция выключена или нет получателей — не отправлено)'}`;
  }
  if (last.severity < s.alertLevel) return null;
  if (ageMin > s.alertMaxAgeMin) return `снимок старше ${s.alertMaxAgeMin} мин — не тревожим`;
  if (last.alerted_at) return null;
  if (sinceAlertMin < s.alertCooldownMin) return `пауза после прошлого оповещения (${Math.round(sinceAlertMin)} мин из ${s.alertCooldownMin})`;

  const flags = (last.flags ?? []).map(f => `${f.level === 2 ? '🔴' : '🟡'} ${f.label}: ${fmtN(f.value)}`).join('\n');
  const top = (last.detail?.mysql?.topFingerprints ?? []).slice(0, 3).map(f => `• ×${f.n}, до ${f.maxSeconds} с: ${f.fingerprint.slice(0, 110)}`).join('\n');
  const work = (last.detail?.working ?? []).slice(0, 3).map(w => `• ${w.seconds} с ${w.method} ${w.path}${w.own ? ' [Монолитика]' : ''}`).join('\n');
  const ownShare = last.http_active ? Math.round(((last.http_own ?? 0) / last.http_active) * 100) : 0;
  const text = [
    `${last.severity === 2 ? '🔴' : '🟡'} Битрикс: высокая нагрузка (${new Date(last.taken_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })} МСК)`,
    flags,
    `Воркеры Apache: ${last.apache_busy ?? '—'} из ${last.apache_slots ?? '—'} · долгих SQL: ${last.mysql_long ?? 0} (макс ${last.mysql_max_sec ?? 0} с) · блокировок: ${last.lock_waits ?? 0} · запросов Монолитики среди активных: ${ownShare}%`,
    top ? `Самые частые долгие запросы:\n${top}` : '', work ? `Самые долгие HTTP-запросы в работе:\n${work}` : '',
    'Подробно: /settings/bitrix-diag',
  ].filter(Boolean).join('\n\n');
  await db.query(`UPDATE b24_diag_snapshots SET alerted_at = now() WHERE id = $1`, [last.id]);
  if (enabled && recipients.length) { await send(text); return `оповещение отправлено (${recipients.length})`; }
  return 'тревога зафиксирована, функция выключена или нет получателей — не отправлено';
}

export type { Snapshot };
