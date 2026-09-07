// «Телевизоры» — хранилище экранов/устройств/сообщений (system DB, миграция 201).
// Чистые CRUD-функции без проверки прав: гейт — в API-роутах через access.ts.

import { randomBytes } from 'crypto';
import { systemDb } from '@/lib/db/clients';
import {
  normalizeSettings, PAIR_CODE_ALPHABET, PAIR_CODE_LEN, PAIR_CODE_TTL_MIN, TV_ONLINE_SEC,
  type TvDeviceInfo, type TvMessage, type TvMessageInput, type TvMessageKind, type TvMode,
  type TvScreen, type TvScreenInput, type TvScreenSettings, type TvTheme,
} from '../shared';

interface ScreenRow {
  id: string; name: string; comment: string | null; public_token: string;
  department_ids: string[]; mode: TvMode; theme: TvTheme; rotate_sec: number;
  ticker_text: string | null; ticker_enabled: boolean; settings: unknown;
  created_at: string; updated_at: string;
}
interface DeviceRow {
  id: string; device_token: string; screen_id: string | null; pair_code: string | null;
  pair_code_expires_at: string | null; label: string | null; user_agent: string | null;
  created_at: string; last_seen_at: string | null; paired_at: string | null;
}

// Даты отдаём строкой ISO в UTC с «Z» (не OF): to_char(..., 'OF') даёт «+00», а
// new Date('…+00') в V8 — Invalid Date, из-за чего первый вариант выдавал телевизору
// новый код привязки на каждом опросе и терял онлайн-статус устройств.

// Токены: публичный токен экрана — 16 символов base32-подобного алфавита (80 бит,
// перебор невозможен даже без rate-limit); токен устройства — 32 hex (128 бит).
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function randomToken(len: number, alphabet = TOKEN_ALPHABET): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
export function newPairCode(): string {
  return randomToken(PAIR_CODE_LEN, PAIR_CODE_ALPHABET);
}

function toDevice(r: DeviceRow): TvDeviceInfo {
  const seen = r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0;
  return {
    id: r.id, label: r.label, userAgent: r.user_agent, lastSeenAt: r.last_seen_at,
    pairedAt: r.paired_at, createdAt: r.created_at,
    online: seen > 0 && Date.now() - seen < TV_ONLINE_SEC * 1000,
  };
}

function toScreen(r: ScreenRow, devices: TvDeviceInfo[], deptNames: Map<string, string>): TvScreen {
  return {
    id: r.id, name: r.name, comment: r.comment, publicToken: r.public_token,
    departmentIds: r.department_ids ?? [],
    departmentNames: (r.department_ids ?? []).map(id => deptNames.get(id) ?? 'Отдел'),
    mode: r.mode, theme: r.theme, rotateSec: Number(r.rotate_sec),
    tickerText: r.ticker_text, tickerEnabled: r.ticker_enabled,
    settings: normalizeSettings(r.settings),
    createdAt: r.created_at, updatedAt: r.updated_at, devices,
  };
}

const SCREEN_COLS = `id, name, comment, public_token, department_ids::text[] AS department_ids, mode, theme, rotate_sec,
  ticker_text, ticker_enabled, settings,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;
const DEVICE_COLS = `id, device_token, screen_id::text AS screen_id, pair_code,
  to_char(pair_code_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS pair_code_expires_at,
  label, user_agent,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen_at,
  to_char(paired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS paired_at`;

export async function listScreens(deptNames: Map<string, string>): Promise<TvScreen[]> {
  const db = systemDb();
  const [screens, devices] = await Promise.all([
    db.query<ScreenRow>(`SELECT ${SCREEN_COLS} FROM tv_screens ORDER BY created_at`),
    db.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM tv_devices WHERE screen_id IS NOT NULL ORDER BY paired_at`),
  ]);
  const byScreen = new Map<string, TvDeviceInfo[]>();
  for (const d of devices.rows) {
    if (!d.screen_id) continue;
    if (!byScreen.has(d.screen_id)) byScreen.set(d.screen_id, []);
    byScreen.get(d.screen_id)!.push(toDevice(d));
  }
  return screens.rows.map(r => toScreen(r, byScreen.get(r.id) ?? [], deptNames));
}

export async function getScreen(id: string, deptNames: Map<string, string>): Promise<TvScreen | null> {
  const db = systemDb();
  const res = await db.query<ScreenRow>(`SELECT ${SCREEN_COLS} FROM tv_screens WHERE id = $1`, [id]);
  const row = res.rows[0];
  if (!row) return null;
  const dev = await db.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM tv_devices WHERE screen_id = $1 ORDER BY paired_at`, [id]);
  return toScreen(row, dev.rows.map(toDevice), deptNames);
}

/** Экран по публичному токену — для фида и страницы /tv/s/<token>. Без устройств. */
export async function getScreenByToken(token: string): Promise<TvScreen | null> {
  if (!/^[a-z0-9]{8,64}$/.test(token)) return null;
  const res = await systemDb().query<ScreenRow>(`SELECT ${SCREEN_COLS} FROM tv_screens WHERE public_token = $1`, [token]);
  const row = res.rows[0];
  return row ? toScreen(row, [], new Map()) : null;
}

export async function createScreen(input: TvScreenInput, createdBy: string | null): Promise<string> {
  const res = await systemDb().query<{ id: string }>(
    `INSERT INTO tv_screens (name, comment, public_token, department_ids, mode, theme, rotate_sec,
                             ticker_text, ticker_enabled, settings, created_by)
     VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING id`,
    [input.name, input.comment, randomToken(16), input.departmentIds, input.mode, input.theme, input.rotateSec,
     input.tickerText, input.tickerEnabled, JSON.stringify(input.settings), createdBy],
  );
  return res.rows[0].id;
}

export async function updateScreen(id: string, input: TvScreenInput): Promise<boolean> {
  const res = await systemDb().query(
    `UPDATE tv_screens SET name = $2, comment = $3, department_ids = $4::uuid[], mode = $5, theme = $6,
            rotate_sec = $7, ticker_text = $8, ticker_enabled = $9, settings = $10::jsonb, updated_at = now()
      WHERE id = $1`,
    [id, input.name, input.comment, input.departmentIds, input.mode, input.theme, input.rotateSec,
     input.tickerText, input.tickerEnabled, JSON.stringify(input.settings)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Только бегущая строка — быстрый рычаг «въебать строку на телевизор».
 *  deptId задан → строка конкретного отдела (settings.deptTickers), иначе общая. */
export async function updateScreenTicker(id: string, text: string | null, enabled: boolean, deptId?: string | null): Promise<boolean> {
  const db = systemDb();
  let res;
  if (deptId) {
    res = text
      ? await db.query(
          `UPDATE tv_screens
              SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{deptTickers}',
                                       COALESCE(settings->'deptTickers', '{}'::jsonb) || jsonb_build_object($2::text, $3::text)),
                  ticker_enabled = $4, updated_at = now()
            WHERE id = $1`,
          [id, deptId, text, enabled])
      : await db.query(
          `UPDATE tv_screens
              SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{deptTickers}',
                                       COALESCE(settings->'deptTickers', '{}'::jsonb) - $2::text),
                  ticker_enabled = $3, updated_at = now()
            WHERE id = $1`,
          [id, deptId, enabled]);
  } else {
    res = await db.query(
      `UPDATE tv_screens SET ticker_text = $2, ticker_enabled = $3, updated_at = now() WHERE id = $1`,
      [id, text, enabled],
    );
  }
  return (res.rowCount ?? 0) > 0;
}

export async function rotateScreenToken(id: string): Promise<string | null> {
  const token = randomToken(16);
  const res = await systemDb().query(`UPDATE tv_screens SET public_token = $2, updated_at = now() WHERE id = $1`, [id, token]);
  return (res.rowCount ?? 0) > 0 ? token : null;
}

export async function deleteScreen(id: string): Promise<boolean> {
  const res = await systemDb().query(`DELETE FROM tv_screens WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

// ── Устройства ──────────────────────────────────────────────────────────────

export interface DeviceState {
  id: string;
  screenId: string | null;
  pairCode: string | null;
  pairCodeExpiresAt: string | null;
}

export async function registerDevice(userAgent: string | null, ip: string | null): Promise<{ token: string; code: string }> {
  const token = randomBytes(16).toString('hex');
  const db = systemDb();
  // Код уникален (partial unique index) — при коллизии пробуем ещё раз.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newPairCode();
    try {
      await db.query(
        `INSERT INTO tv_devices (device_token, pair_code, pair_code_expires_at, user_agent, last_ip, last_seen_at)
         VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4, $5, now())`,
        [token, code, String(PAIR_CODE_TTL_MIN), userAgent, ip],
      );
      return { token, code };
    } catch (e) {
      if (attempt === 4) throw e;
    }
  }
  throw new Error('unreachable');
}

export async function getDeviceByToken(token: string): Promise<DeviceState | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const res = await systemDb().query<{ id: string; screen_id: string | null; pair_code: string | null; pair_code_expires_at: string | null }>(
    `SELECT id, screen_id::text AS screen_id, pair_code,
            to_char(pair_code_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS pair_code_expires_at
       FROM tv_devices WHERE device_token = $1`,
    [token],
  );
  const r = res.rows[0];
  return r ? { id: r.id, screenId: r.screen_id, pairCode: r.pair_code, pairCodeExpiresAt: r.pair_code_expires_at } : null;
}

/** Непривязанное устройство: вернуть действующий код или выдать новый. */
export async function ensurePairCode(device: DeviceState): Promise<{ code: string; expiresInSec: number }> {
  const exp = device.pairCodeExpiresAt ? new Date(device.pairCodeExpiresAt).getTime() : 0;
  if (device.pairCode && exp - Date.now() > 60_000) {
    return { code: device.pairCode, expiresInSec: Math.round((exp - Date.now()) / 1000) };
  }
  const db = systemDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newPairCode();
    try {
      await db.query(
        `UPDATE tv_devices SET pair_code = $2, pair_code_expires_at = now() + ($3 || ' minutes')::interval WHERE id = $1`,
        [device.id, code, String(PAIR_CODE_TTL_MIN)],
      );
      return { code, expiresInSec: PAIR_CODE_TTL_MIN * 60 };
    } catch (e) {
      if (attempt === 4) throw e;
    }
  }
  throw new Error('unreachable');
}

// last_seen_at пишем не чаще раза в 45 с на устройство — телевизоры опрашивают
// фид каждые 15 с, UPDATE на каждый опрос не нужен.
const _seenAt = new Map<string, number>();
export async function touchDevice(id: string, ip: string | null): Promise<void> {
  const last = _seenAt.get(id) ?? 0;
  if (Date.now() - last < 45_000) return;
  _seenAt.set(id, Date.now());
  await systemDb().query(`UPDATE tv_devices SET last_seen_at = now(), last_ip = COALESCE($2, last_ip) WHERE id = $1`, [id, ip]).catch(() => {});
}

/** Привязка по коду. Возвращает id устройства или null (кода нет / истёк). */
export async function pairDeviceByCode(code: string, screenId: string, label: string | null): Promise<string | null> {
  const norm = code.trim().toUpperCase().replace(/[^A-Z2-9]/g, '');
  if (norm.length !== PAIR_CODE_LEN) return null;
  const res = await systemDb().query<{ id: string }>(
    `UPDATE tv_devices
        SET screen_id = $2, pair_code = NULL, pair_code_expires_at = NULL, paired_at = now(),
            label = COALESCE($3, label)
      WHERE pair_code = $1 AND pair_code_expires_at > now()
      RETURNING id`,
    [norm, screenId, label],
  );
  return res.rows[0]?.id ?? null;
}

export async function unpairDevice(deviceId: string): Promise<boolean> {
  const res = await systemDb().query(
    `UPDATE tv_devices SET screen_id = NULL, paired_at = NULL WHERE id = $1 AND screen_id IS NOT NULL`,
    [deviceId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function updateDeviceLabel(deviceId: string, label: string | null): Promise<boolean> {
  const res = await systemDb().query(`UPDATE tv_devices SET label = $2 WHERE id = $1`, [deviceId, label]);
  return (res.rowCount ?? 0) > 0;
}

export async function deviceScreenId(deviceId: string): Promise<string | null> {
  const res = await systemDb().query<{ screen_id: string | null }>(`SELECT screen_id::text AS screen_id FROM tv_devices WHERE id = $1`, [deviceId]);
  return res.rows[0]?.screen_id ?? null;
}

/** Чистка: непривязанные устройства, не выходившие на связь неделю (телевизор,
 *  который открыл /tv и ушёл), — иначе таблица копится от случайных заходов. */
export async function purgeStaleDevices(): Promise<number> {
  const res = await systemDb().query(
    `DELETE FROM tv_devices WHERE screen_id IS NULL AND COALESCE(last_seen_at, created_at) < now() - interval '7 days'`,
  );
  return res.rowCount ?? 0;
}

// ── Сообщения ───────────────────────────────────────────────────────────────

interface MessageRow {
  id: string; kind: TvMessageKind; text: string; target_screen_ids: string[] | null;
  starts_at: string; ends_at: string; created_by_name: string | null; created_at: string; active: boolean;
}
const MESSAGE_COLS = `id, kind, text, target_screen_ids::text[] AS target_screen_ids,
  to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
  to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
  created_by_name,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  (starts_at <= now() AND ends_at > now()) AS active`;

function toMessage(r: MessageRow, screenNames: Map<string, string>): TvMessage {
  return {
    id: r.id, kind: r.kind, text: r.text, targetScreenIds: r.target_screen_ids,
    targetScreenNames: r.target_screen_ids ? r.target_screen_ids.map(id => screenNames.get(id) ?? 'экран удалён') : null,
    startsAt: r.starts_at, endsAt: r.ends_at, createdByName: r.created_by_name, createdAt: r.created_at, active: r.active,
  };
}

/** Активные и недавние (24 ч после окончания) — история для админки. */
export async function listMessages(screenNames: Map<string, string>): Promise<TvMessage[]> {
  const res = await systemDb().query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM tv_messages WHERE ends_at > now() - interval '24 hours' ORDER BY starts_at DESC LIMIT 200`,
  );
  return res.rows.map(r => toMessage(r, screenNames));
}

/** Активные сообщения для экрана (фид). */
export async function activeMessagesForScreen(screenId: string): Promise<{ id: string; kind: TvMessageKind; text: string; until: string }[]> {
  const res = await systemDb().query<{ id: string; kind: TvMessageKind; text: string; until: string }>(
    `SELECT id, kind, text, to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS until
       FROM tv_messages
      WHERE starts_at <= now() AND ends_at > now()
        AND (target_screen_ids IS NULL OR $1::uuid = ANY(target_screen_ids))
      ORDER BY starts_at`,
    [screenId],
  );
  return res.rows;
}

export async function createMessage(input: TvMessageInput, endsAt: Date, createdBy: string | null, createdByName: string | null): Promise<string> {
  const res = await systemDb().query<{ id: string }>(
    `INSERT INTO tv_messages (kind, text, target_screen_ids, ends_at, created_by, created_by_name)
     VALUES ($1, $2, $3::uuid[], $4, $5, $6) RETURNING id`,
    [input.kind, input.text, input.targetScreenIds, endsAt.toISOString(), createdBy, createdByName],
  );
  return res.rows[0].id;
}

/** «Снять» сообщение = закончить его сейчас (история остаётся). */
export async function stopMessage(id: string): Promise<boolean> {
  const res = await systemDb().query(`UPDATE tv_messages SET ends_at = now() WHERE id = $1 AND ends_at > now()`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function getMessageTargets(id: string): Promise<string[] | null | undefined> {
  const res = await systemDb().query<{ target_screen_ids: string[] | null }>(
    `SELECT target_screen_ids::text[] AS target_screen_ids FROM tv_messages WHERE id = $1`, [id],
  );
  if (res.rows.length === 0) return undefined;
  return res.rows[0].target_screen_ids;
}

export type { TvScreenSettings };
